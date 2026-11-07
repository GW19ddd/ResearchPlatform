"""科研导航 · 应用内网页浏览代理。

外部站点普遍带 X-Frame-Options / CSP frame-ancestors，直接把 URL 塞进 iframe
会被浏览器拒绝（白屏）。这里由服务端把目标 HTML 拉回本机，注入 <base> 与
导航劫持脚本后以本服务同源返回；iframe 的 src 指向 /api/browse?url=...，
网页就能在工作台内部打开，而不再跳到浏览器。

边界（写清楚，别当透明代理用）：
- 只代理 http/https 的 GET；这是本机单用户应用，不对公网开放。
- 只处理 text/html；PDF / 下载类链接给一个带「在浏览器打开」的提示页。
- 注入 <base> 后，样式/图片/脚本等子资源仍直连目标站点；SPA 型站点的
  同域 XHR 可能因跨源失败 —— 工具栏备有「直连」「在浏览器打开」两个出口。
- 站点 Cookie 不透传，登录态站点以游客视图呈现。
"""
from __future__ import annotations

import html as html_lib
import re
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Query
from fastapi.responses import HTMLResponse

router = APIRouter(prefix="/api/browse", tags=["browse"])

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
_HEADERS = {
    "User-Agent": _UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Upgrade-Insecure-Requests": "1",
}
_TIMEOUT = 20.0
_MAX_BYTES = 8_000_000

# 注入到目标页 <head> 最前面的脚本：
# 1) 站内链接 / GET 表单的跳转重新指回代理，浏览全程留在应用内；
# 2) 去掉 target，避免点击后弹出浏览器新标签；
# 3) 把当前真实 URL postMessage 给外层，用来同步地址栏。
# 注意：location.origin 取的是本应用源，不受 <base> 影响，别用相对路径。
_JS = r"""
<script>
(function(){
  var PROXY=location.origin+'/api/browse?url=';
  function proxify(u){ return PROXY+encodeURIComponent(u); }
  function abs(href){
    try { return new URL(href, document.baseURI).href; } catch(e){ return ''; }
  }
  function safe(u){
    try { return /^https?:$/.test(new URL(u).protocol); } catch(e){ return false; }
  }
  document.addEventListener('click', function(e){
    if(e.defaultPrevented || e.button!==0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var t=e.target, a=(t&&t.closest)?t.closest('a[href]'):null;
    if(!a) return;
    var h=a.getAttribute('href');
    if(!h || h.charAt(0)==='#' || /^(javascript|mailto|tel|data):/i.test(h)) return;
    var u=abs(h);
    if(!u || !safe(u)) return;
    e.preventDefault();
    window.location.href=proxify(u);
  }, true);
  document.addEventListener('submit', function(e){
    var f=e.target;
    if(!f || f.tagName!=='FORM') return;
    if((f.getAttribute('method')||'get').toLowerCase()!=='get') return;
    var u;
    try { u=new URL(f.getAttribute('action')||document.baseURI, document.baseURI); }
    catch(err){ return; }
    if(!safe(u.href)) return;
    try {
      var d=new FormData(f);
      d.forEach(function(v,k){ if(typeof v==='string') u.searchParams.append(k,v); });
    } catch(err){}
    e.preventDefault();
    window.location.href=proxify(u.href);
  }, true);
  function fix(){
    try { document.querySelectorAll('a[target]').forEach(function(a){ a.removeAttribute('target'); }); } catch(e){}
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', fix);
  else fix();
  setInterval(fix, 2000);
  try { parent.postMessage({__wbBrowse:1, url:location.href}, '*'); } catch(e){}
})();
</script>
"""


def _notice(title: str, detail: str, url: str) -> HTMLResponse:
    """代理失败 / 非网页资源：在 iframe 里给一张能自救的提示页。"""
    esc = lambda s: html_lib.escape(str(s), quote=True)  # noqa: E731
    return HTMLResponse(
        "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<style>"
        "body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;"
        "background:#fafbfc;color:#1f2430;font:14px/1.7 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif}"
        ".box{max-width:520px;padding:28px 30px;border:1px solid #e3e6ea;border-radius:14px;background:#fff;box-shadow:0 8px 28px rgba(20,24,40,.06)}"
        "h1{margin:0 0 10px;font-size:16px}p{margin:0 0 8px;color:#6a7382}"
        "a{display:inline-block;margin-top:14px;padding:8px 14px;border-radius:9px;background:#4f46e5;color:#fff;text-decoration:none;font-size:13px}"
        "code{font-size:12px;color:#8a94a6;word-break:break-all}"
        "</style></head><body><div class='box'>"
        f"<h1>{esc(title)}</h1><p>{esc(detail)}</p>"
        f"<p><code>{esc(url[:240])}</code></p>"
        f"<a href='{esc(url)}' target='_blank' rel='noreferrer'>在浏览器打开</a>"
        "<p style='margin-top:14px;font-size:12px'>也可以点顶部「直连」切回原始地址，或换个站点。</p>"
        "</div></body></html>"
    )


def _decode(content: bytes, ctype: str) -> str:
    """按响应头 / HTML meta 猜编码，统一解码成 str 后以 UTF-8 回吐。"""
    enc = None
    m = re.search(r"charset\s*=\s*[\"']?\s*([\w-]+)", ctype, re.I)
    if m:
        enc = m.group(1)
    if not enc:
        head = content[:8192].decode("ascii", errors="ignore")
        m2 = re.search(r"charset\s*=\s*[\"']?\s*([\w-]+)", head, re.I)
        if m2:
            enc = m2.group(1)
    if not enc:
        enc = "utf-8"
    try:
        return content.decode(enc, errors="replace")
    except LookupError:
        return content.decode("utf-8", errors="replace")


def _inject(raw_html: str, final_url: str) -> str:
    """注入 charset / <base> / 导航脚本，全部放在 <head> 最前面。"""
    # 原页面的 charset 声明必须去掉：我们按 UTF-8 回吐，留着会乱码
    text = re.sub(r"<meta\s+[^>]*charset\s*=\s*[^>]*>", "", raw_html, flags=re.I)
    text = re.sub(
        r"<meta\s+[^>]*http-equiv\s*=\s*['\"]?content-type['\"]?[^>]*>",
        "",
        text,
        flags=re.I,
    )
    inject = (
        '<meta charset="utf-8">'
        + '<base href="'
        + html_lib.escape(final_url, quote=True)
        + '">'
        + _JS
    )
    m = re.search(r"<head[^>]*>", text, flags=re.I)
    if m:
        return text[: m.end()] + inject + text[m.end() :]
    return inject + text


@router.get("")
def browse(url: str = Query(..., description="要在本应用内打开的网页地址")):
    """把目标网页以本服务同源回吐，供科研导航的 iframe 内嵌打开。"""
    target = (url or "").strip()
    parsed = urlparse(target)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return _notice("地址不合法", "只支持 http / https 网页。", target)

    try:
        with httpx.Client(timeout=_TIMEOUT, follow_redirects=True, headers=_HEADERS) as client:
            resp = client.get(target)
    except Exception as e:  # noqa: BLE001 —— 网络异常要变成可读的提示页
        return _notice("没能打开这个网页", f"请求失败：{e}", target)

    final_url = str(resp.url)
    ctype = (resp.headers.get("content-type") or "").lower()

    if resp.status_code >= 400:
        return _notice(
            "站点拒绝了这次访问",
            f"HTTP {resp.status_code}。部分站点会拦截非浏览器访问，可切「直连」或「在浏览器打开」。",
            final_url,
        )
    if "html" not in ctype:
        return _notice(
            "这个链接不是网页",
            f"响应类型：{ctype or '未知'}。PDF / 下载文件请在浏览器中打开。",
            final_url,
        )
    if len(resp.content) > _MAX_BYTES:
        return _notice("页面太大", "超过 8 MB，建议在浏览器中打开。", final_url)

    return HTMLResponse(_inject(_decode(resp.content, ctype), final_url))
