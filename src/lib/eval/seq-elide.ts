/**
 * 序列片段省略工具（纯函数，前后端共用）。
 *
 * 背景：LLM 从评估表提取要点时，可能原样带出上百个残基的连续氨基酸序列
 * （如抗体 Fc 区）。该序列已在「识别出的序列」区域规范展示，在要点文本中
 * 重复出现既冗余，又会因无空格长 token 无法换行而溢出容器。
 *
 * 策略：连续 ≥ SEQ_MIN_RUN 个无空格拉丁字母在正常中英文词汇中不可能出现
 * （最长英文单词约 30 字符），视为序列片段，替换为省略标记。
 * 40 以下的短片段（linker、标签序列等）保留展示，由前端 break-words 兜底换行。
 */
const SEQ_MIN_RUN = 40

/** 将文本中的长序列片段替换为「〔序列 N aa，此处省略〕」标记 */
export function elideSequenceRuns(text: string | null | undefined): string {
  if (!text) return ''
  const re = new RegExp(`[A-Za-z]{${SEQ_MIN_RUN},}`, 'g')
  return text.replace(re, (run) => `〔序列 ${run.length} aa，此处省略〕`)
}
