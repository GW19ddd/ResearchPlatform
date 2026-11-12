import { createWorkBuddyCloud } from '@tencent-ai/workbuddy-cloud-sdk'

/**
 * WorkBuddy 云端账户客户端。
 *
 * 只有公开配置（endpoint / publishableKey / oauthRelayBaseUrl）在这里 ——
 * 它们本来就会出现在浏览器里，真正有权限的是服务端。本机后端拿到云端
 * access token 后会自己向云端校验一次，所以这里不做任何身份判断。
 */
export const CLOUD_CONFIG = {
  endpoint: 'https://growth-workbench-66823.app.workbuddy.host',
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
  publishableKey: 'wbpk_NQ2QLlIHOvJdrFUEBwKc2V_Cnx0n2HUHSWPJSS7UiSdax6FbphQu3BF',
}

export const cloud = createWorkBuddyCloud(CLOUD_CONFIG)

/** 微信扫码登录的回跳地址必须是站点根：静态托管没有 history fallback。 */
export function wechatRedirectTo(): string {
  return location.origin
}

export type CloudIdentity = {
  email?: string | null
  phone?: string | null
  name?: string | null
}

/** 从云端错误对象里取一句人话（SDK 的 error 形状是 { kind, message }）。 */
export function cloudErrText(err: unknown): string {
  const e = err as any
  return String(e?.message || e?.error_description || e?.kind || err || '云端登录失败')
}
