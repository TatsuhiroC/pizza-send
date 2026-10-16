export function remainingTime(total: number, transferred: number, speed: number, phase = 'sending') {
  if (phase === 'done') return '完成';
  if (phase === 'recovering') return '等待网络恢复';
  if (phase === 'error' || phase === 'left') return '已停止';
  if (total > 0 && transferred >= total) return '正在校验';
  if (!Number.isFinite(speed) || speed <= 0) return '正在估算';
  const seconds = Math.max(1, Math.ceil(Math.max(0, total - transferred) / speed));
  return seconds > 60 ? Math.ceil(seconds / 60) + ' 分钟' : seconds + ' 秒';
}
