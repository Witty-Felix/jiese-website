// 打卡统计行计算的共享工具（stats.js 与 admin/checkin.js 共用；下划线前缀不参与路由）

export function yesterdayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// 由某用户的全量打卡日期集合计算榜单行（与 /api/stats 口径一致）
export function computeRow(nickname, dates, today) {
  const yesterday = yesterdayOf(today);
  const sorted = [...dates].sort().reverse(); // 新→旧
  let streak = 0;
  let expect = dates.has(today) ? today : (dates.has(yesterday) ? yesterday : null);
  while (expect && dates.has(expect)) {
    streak += 1;
    expect = yesterdayOf(expect);
  }
  return {
    nickname,
    total: dates.size,
    streak,
    last_date: sorted[0],
    checked_today: dates.has(today),
  };
}
