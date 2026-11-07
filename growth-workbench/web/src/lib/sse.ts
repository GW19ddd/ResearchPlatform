/**
 * SSE（Server-Sent Events）分块解析：把一段可能不完整的字节流切成一条条事件。
 *
 * 协议里一个事件以空行（`\n\n`）结尾。网络分块可能把一条事件从中间切断，所以要维护一个
 * 「剩余缓冲」：本次没凑齐完整事件的尾巴留到下次。
 *
 * 纯函数，便于单测各种边界（事件正好在分块边界被切断、多个事件挤在一个 chunk、空 chunk 等）。
 */
export interface SseEvent {
  type: string
  [key: string]: unknown
}

export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  // 按事件分隔符切；最后一块（可能不完整）作为 rest 留给下次
  const parts = buffer.split('\n\n')
  const rest = parts.pop() ?? ''
  const events: SseEvent[] = []
  for (const part of parts) {
    // 一个 block 可能有多行（如 `event: x\ndata: y`）；只取以 data: 开头的行，
    // 多段 data: 按规范用换行拼接。这样「event 行 + data 行」的块也能正确解析。
    const dataLines = part
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5)) // 去掉 "data:"
    if (dataLines.length === 0) continue
    const payload = dataLines.join('\n')
    try {
      events.push(JSON.parse(payload) as SseEvent)
    } catch {
      // 单条解析失败不影响其它事件（模型偶尔吐出非法片段）
    }
  }
  return { events, rest }
}
