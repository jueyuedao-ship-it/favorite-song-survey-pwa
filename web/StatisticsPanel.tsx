import { useCallback, useMemo, useState } from "react";
import type { CreditRole, Statistics } from "../shared/contracts";
import { todayInJapan } from "./dates";
import { useVisibleRefresh } from "./useVisibleRefresh";

type ApiReader = { get<T>(path: string, options?: { signal?: AbortSignal }): Promise<T> };
type Props = { api: ApiReader; participantId?: string; mode: "rankings" | "personal" };

const periodNames = { all: "全期間", week: "週", month: "月", day: "日", custom: "任意期間" } as const;
const roleNames: Record<CreditRole, string> = {
  vocalist: "ボーカル",
  composer: "作曲者",
  release_name: "発表名義",
  uploader: "投稿チャンネル",
};

function percent(value: number): string {
  return `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(value)}％`;
}

export function StatisticsPanel({ api, participantId, mode }: Props) {
  const [period, setPeriod] = useState<keyof typeof periodNames>(mode === "rankings" ? "all" : "week");
  const [groupBy, setGroupBy] = useState<"work" | "version">("work");
  const [statistics, setStatistics] = useState<Statistics>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [anchor, setAnchor] = useState(todayInJapan());
  const [from, setFrom] = useState(todayInJapan());
  const [to, setTo] = useState(todayInJapan());
  const [display, setDisplay] = useState<"count" | "percentage">("percentage");
  const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  const dateError = !validDate(anchor) || (period === "custom" && (!validDate(from) || !validDate(to) || from > to))
    ? "基準日と期間の開始・終了を確認してください。" : "";

  const query = useMemo(() => {
    const params = new URLSearchParams({ period: period === "custom" ? "all" : period, anchor, group_by: groupBy });
    if (period === "custom") { params.set("from", from); params.set("to", to); }
    if (mode === "personal" && participantId) params.set("participant_id", participantId);
    return params.toString();
  }, [groupBy, mode, participantId, period, anchor, from, to]);

  const refresh = useCallback(async (signal: AbortSignal) => {
    if (mode === "personal" && !participantId) {
      setStatistics(undefined);
      return;
    }
    if (dateError) { setLoading(false); return; }
    setLoading(true);
    setError("");
    try {
      const data = await api.get<Statistics>(`/statistics?${query}`, { signal });
      if (!signal.aborted) setStatistics(data);
    } catch (reason) {
      if (!signal.aborted) setError(reason instanceof Error ? reason.message : "統計を読み込めませんでした。");
    } finally { if (!signal.aborted) setLoading(false); }
  }, [api, mode, participantId, query, dateError]);
  useVisibleRefresh(refresh);

  if (mode === "personal" && !participantId) {
    return <section className="empty-state"><h2>個人統計</h2><p>表示する参加者を選んでください。</p></section>;
  }

  return <section className="content-panel statistics-panel">
    <header className="section-heading">
      <div>
        <p className="eyebrow">{mode === "rankings" ? "みんなの回答" : "あなたの記録"}</p>
        <h2>{mode === "rankings" ? "みんなの人気曲" : "個人の傾向"}</h2>
      </div>
      <div className="statistics-controls">
        <label>集計期間
          <select value={period} onChange={(event) => setPeriod(event.target.value as keyof typeof periodNames)}>
            {Object.entries(periodNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>基準日<input type="date" value={anchor} onChange={(event) => setAnchor(event.target.value)} required /></label>
        {period === "custom" && <>
          <label>開始日<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} required /></label>
          <label>終了日<input type="date" value={to} onChange={(event) => setTo(event.target.value)} required /></label>
        </>}
        <label>曲のまとめ方
          <select value={groupBy} onChange={(event) => setGroupBy(event.target.value as "work" | "version")}>
            <option value="work">作品ごと</option>
            <option value="version">歌唱・演奏版ごと</option>
          </select>
        </label>
      </div>
    </header>

    {loading && <p className="inline-status" role="status">集計を読み込んでいます…</p>}
    {(dateError || error) && <p className="notice notice-error" role="alert">{dateError || error}</p>}
    {statistics && <>
      <div className="summary-strip" aria-label="集計概要">
        <div><strong>{statistics.total_records}</strong><span>有効な回答</span></div>
        <div><strong>{statistics.unparsed_records}</strong><span>未解析</span></div>
        <div><strong>{statistics.from}〜{statistics.to}</strong><span>集計期間</span></div>
      </div>

      {mode === "rankings" ? <section className="subsection">
        <h3>人気曲の順位</h3>
        {statistics.rankings.length === 0 ? <p className="empty-state">この期間のランキングはまだありません。</p> :
          <ol className="ranking-list">
            {statistics.rankings.map((item) => <li key={item.id} className="ranking-card">
              <span className="rank-number">{item.rank}</span>
              <div className="ranking-title"><strong>{item.title}</strong>
                <span>{groupBy === "work" ? "作品単位" : "バージョン単位"}</span></div>
              <div className="ranking-count"><strong>{item.count}件</strong><span>{item.supporter_count}人が記録</span></div>
              <p className="supporters">{item.supporters.map((person) => person.name).join("、")}</p>
            </li>)}
          </ol>}
        <p className="muted-note">順位は応援した人の数ではなく、有効な回答件数で決まります。</p>
      </section> : <>
        <section className="subsection tag-section">
          <div className="section-heading compact-heading">
            <div><h3>タグの週ごとの推移</h3><p>基準日までの12週（月曜開始）。割合の分母は未解析を含む各週の全回答数です。</p></div>
            <label>表示方法<select value={display} onChange={(event) => setDisplay(event.target.value as "count" | "percentage")}><option value="percentage">割合</option><option value="count">件数</option></select></label>
          </div>
          {statistics.weekly_tags.length === 0 || statistics.weekly_tags.every((week) => week.tags.length === 0)
            ? <p className="empty-state">タグが確認された回答はまだありません。未解析の回答は個人履歴に残ります。</p>
            : <>
              <p className="parsing-note">未解析 {statistics.unparsed_records}件</p>
              <div className="chart-frame">
                <svg className="tag-chart" role="img" aria-label="週ごとのタグ件数と割合"
                  viewBox={`0 0 760 ${Math.max(130, statistics.weekly_tags.reduce((total, week) => total + Math.max(1, week.tags.length), 0) * 31 + 40)}`}>
                  {(() => {
                    const rows = statistics.weekly_tags.flatMap((week) => week.tags.map((tag) => ({ week, tag })));
                    const maximum = Math.max(1, ...rows.map(({ tag }) => display === "count" ? tag.count : tag.percentage));
                    return rows.map(({ week, tag }, index) => {
                      const y = index * 31 + 26;
                      const width = Math.max(2, ((display === "count" ? tag.count : tag.percentage) / maximum) * 430);
                      return <g key={`${week.week_start}-${tag.tag_id}`}>
                        <text x="8" y={y + 14} className="chart-week">{week.week_start}</text>
                        <text x="102" y={y + 14} className="chart-tag">{tag.name}</text>
                        <rect x="226" y={y} width={width} height="20" rx="8" className="chart-bar" />
                        <text x={236 + width} y={y + 14} className="chart-value">{tag.count}件 · {percent(tag.percentage)}</text>
                      </g>;
                    });
                  })()}
                </svg>
              </div>
              <div className="table-scroll">
                <table>
                  <caption>週ごとのタグ集計</caption>
                  <thead><tr><th scope="col">週の開始日</th><th scope="col">回答数</th><th scope="col">未解析</th><th scope="col">タグ</th><th scope="col">件数</th><th scope="col">割合</th></tr></thead>
                  <tbody>{statistics.weekly_tags.flatMap((week) => week.tags.length
                    ? week.tags.map((tag) => <tr key={`${week.week_start}-${tag.tag_id}`}>
                      <th scope="row">{week.week_start}</th><td>{week.total_records}</td><td>{week.unparsed_records}</td><td>{tag.name}</td><td>{tag.count}</td><td>{percent(tag.percentage)}</td>
                    </tr>)
                    : [<tr key={`${week.week_start}-none`}><th scope="row">{week.week_start}</th><td>{week.total_records}</td><td>{week.unparsed_records}</td><td colSpan={3}>確認済みタグなし</td></tr>])}</tbody>
                </table>
              </div>
            </>}
          <p className="muted-note">複数のタグが付くため、割合の合計は100％を超えることがあります。</p>
        </section>

        <section className="subsection">
          <h3>関係者別の回答</h3>
          <div className="role-grid">{(Object.keys(roleNames) as CreditRole[]).map((role) => {
            const rows = statistics.roles[role];
            return <section key={role} className="role-card"><h4>{roleNames[role]}</h4>
              {rows.length ? <ul>{rows.slice(0, 8).map((row) => <li key={row.entity_id}><span>{row.name}</span><strong>{row.count}件</strong></li>)}</ul>
                : <p className="muted-note">確認済み情報はありません。</p>}
            </section>;
          })}</div>
        </section>
      </>}
    </>}
  </section>;
}
