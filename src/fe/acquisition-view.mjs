import { SOURCE_LABELS, SOURCE_REASONS, acquisitionSummary } from "./acquisitions.mjs";
import { escapeHTML as e, number, percent, sectionHeading } from "./ui.mjs";
import { acquisitionGrade } from "./acquisition-grades.mjs";

const points = (value) => number(value / 100, 2);
const option = (value, label, selected) => `<option value="${e(value)}" ${String(value) === String(selected) ? "selected" : ""}>${e(label)}</option>`;
const sourceChip = (source) => `<span class="source-chip source-${source}">${SOURCE_LABELS[source]}</span>`;
const signedPoints = (value) => `${value > 0 ? "+" : ""}${points(value)}`;
const gradeBadge = (grade) => `<span class="acquisition-grade grade-${grade ? grade[0].toLowerCase() : "unknown"}">${grade ?? "N/A"}</span>`;

function playerGrade(player, grades) {
  const result = acquisitionGrade(player.evidence[0], grades);
  if (!result.report || !result.side) {
    return `<span title="${e(result.reason)}">${gradeBadge(result.grade)}</span>`;
  }
  const { report, side } = result;
  return `<details class="player-grade"><summary>${gradeBadge(result.grade)}</summary>
    <p>${e(result.reason || `${points(side.points)} received starter pts; ${signedPoints(side.margin)} net.`)}</p>
    <p>${report.estimated ? "Includes estimated unmade picks. " : ""}Full-history grade through ${grades.lastSeason}, not just the selected games.</p>
    <a href="#trade-${e(report.key)}" data-trade-report="${e(report.key)}">View full trade</a></details>`;
}

function tradeLedger(grades, displayed, state, era, mode) {
  if (!grades) return "";
  const origins = new Set(displayed.flatMap((group) => group.players.flatMap((player) =>
    player.evidence.filter((entry) => entry.source === "trade").map((entry) =>
      `${entry.originPlatform ?? entry.platform}:${entry.acquiredSeason}:${entry.event}`))));
  const reports = grades.reports.filter((report) =>
    (era === "all" || report.platform === era || origins.has(report.key)) &&
    (!state.acquisitionSeason || report.season === Number(state.acquisitionSeason) || origins.has(report.key)) &&
    (!state.acquisitionManager || origins.has(report.key) ||
      report.sides.some((side) => side.team[mode].id === state.acquisitionManager)));
  return `<details class="trade-ledger"><summary>Trade report cards <span>${reports.length} trades · ${reports.filter((report) => report.issues.length).length} unavailable</span></summary>
    <p class="section-footnote">Trades in the selected era/season, plus original trades behind the displayed players. Returns always use full covered regular-season history through ${grades.lastSeason}.
    Each received player shares its team's grade for the entire deal. Pick-only trades are included.</p>
    ${reports.length ? reports.map((report) => `<details class="trade-report" id="trade-${e(report.key)}"><summary>
    <span><strong>${report.season} · ${report.platform === "espn" ? "ESPN" : "Sleeper"}</strong><small>${new Date(report.at).toISOString().slice(0, 10)} UTC${report.estimated ? " · Includes pick estimates" : ""}</small></span>
    <span class="trade-grades">${report.sides.map((side) => `<span>${e(side.team[mode].name)} ${gradeBadge(side.grade)}</span>`).join("")}</span></summary>
    ${report.issues.length ? `<p class="coverage-note"><strong>Grade unavailable:</strong> ${e(report.issues.join("; "))}. Observed returns below are incomplete, not zero-value assumptions.</p>` : ""}
    <div class="trade-sides">${report.sides.map((side) => `<section><h4>${e(side.team[mode].name)} ${gradeBadge(side.grade)}</h4>
    <p><strong>${points(side.points)} pts received</strong> · ${signedPoints(side.margin)} net<br>
    Compared with ${points(side.opponentPoints)} pts${report.sides.length > 2 ? " (other teams' average)" : " for the other team"}.</p>
    <ul>${side.assets.length ? side.assets.map((asset) => `<li><strong>${e(asset.name)}</strong>
    <span>${asset.points === null ? "Return unavailable" : `${points(asset.points)} pts`}${asset.estimated ? " (estimated)" : ""}</span><small>${e(asset.note)}</small></li>`).join("") :
      "<li>No directly received players or resolved picks recorded.</li>"}</ul></section>`).join("")}</div>
    <p class="section-footnote">Trade ID: <code>${e(report.id)}</code></p></details>`).join("") :
      '<p class="empty">No recorded trades match these filters.</p>'}</details>`;
}
function sourceBar(buckets, total) {
  if (total <= 0 || Object.values(buckets).some((value) => value < 0)) {
    return '<p class="section-footnote">Signed net contributions shown below; no percentage bar for zero/negative totals or source buckets.</p>';
  }
  return `<div class="source-bar" role="img" aria-label="${e(Object.entries(buckets).map(([source, value]) =>
    `${SOURCE_LABELS[source]} ${percent(value / total)}`).join(", "))}">
    ${Object.entries(buckets).map(([source, value]) => `<span class="source-${source}" style="width:${value / total * 100}%"></span>`).join("")}</div>`;
}

export function renderAcquisitions({ analytics, acquisitions, tradeGrades, rows, state, era, mode }) {
  const heading = sectionHeading("HOW THE ROSTER WAS BUILT", "Points by acquisition",
    "Follow the points from the draft room, the trade desk, and the waiver wire. ESPN 2018–2021 + Sleeper 2022–2025.");
  if (!acquisitions) throw new Error("Acquisition data is not loaded");
  if (era === "espn" && state.acquisitionScope === "playoff") state.acquisitionScope = "regular";
  const scope = state.acquisitionScope ?? "regular";
  const available = acquisitions.filter((row) => era === "all" || row.platform === era);
  const seasons = [...new Set(available.filter((row) => scope !== "playoff" || row.platform === "sleeper")
    .map((row) => row.season))].sort((a, b) => b - a);
  if (state.acquisitionSeason && !seasons.includes(Number(state.acquisitionSeason))) state.acquisitionSeason = "";
  const groups = acquisitionSummary(available, analytics.games, rows, mode, state.acquisitionSeason, scope, era);
  if (state.acquisitionManager && !groups.some((group) => group.id === state.acquisitionManager)) state.acquisitionManager = "";
  const displayed = groups.filter((group) => !state.acquisitionManager || group.id === state.acquisitionManager);
  const buckets = { draft: 0, trade: 0, freeAgency: 0, unknown: 0 };
  for (const group of displayed) for (const source of Object.keys(buckets)) buckets[source] += group.buckets[source];
  const total = displayed.reduce((sum, group) => sum + group.points, 0);
  const teamPoints = displayed.reduce((sum, group) => sum + group.teamPoints, 0);
  const adjustment = teamPoints - total;
  const captured = total > 0 ? (total - buckets.unknown) / total : null;
  const years = seasons.length ? `${seasons.at(-1)}–${seasons[0]}` : "No covered seasons";
  const coverageNote = era === "sleeper" ? "" :
    '<p class="coverage-note"><strong>ESPN coverage: 2018–2021 regular season only.</strong> Acquisition lookback begins with the 2016 initial draft; keeper selections preserve the latest prior acquisition. Trades with missing player details are ignored. This is best-effort history: early transaction records are incomplete. ESPN 2016–2017 and postseason points are excluded, not counted as zero.</p>';
  return heading + coverageNote +
    `<div class="feature-controls"><label>Season<select id="acquisitionSeason">${option("", "All completed seasons", state.acquisitionSeason)}
    ${seasons.map((season) => option(season, season, state.acquisitionSeason)).join("")}</select></label>
    <label>Manager<select id="acquisitionManager">${option("", "All managers", state.acquisitionManager)}
    ${groups.map((group) => option(group.id, group.name, state.acquisitionManager)).join("")}</select></label>
    <label>Games<select id="acquisitionScope">${option("regular", "Regular season", scope)}
    ${era === "espn" ? "" : option("playoff", "Verified title bracket (Sleeper)", scope)}${option("all", "All covered games incl. Sleeper placement", scope)}</select></label></div>
    <div class="acquisition-hero"><div class="acquisition-headline"><div><span class="eyebrow accent">STARTER POINTS ACCOUNTED FOR</span>
    <strong>${points(total)}</strong><p>${state.acquisitionManager ? e(displayed[0]?.name ?? "") : mode === "owner" ? "All owners" : "All franchises"} · ${state.acquisitionSeason || years} · ${scope === "regular" ? "Regular season" : scope === "playoff" ? "Sleeper title bracket" : "All covered games"}</p></div>
    <div class="source-coverage"><strong>${captured === null ? "—" : percent(captured)}</strong><span>points with an assigned source</span></div></div>
    ${sourceBar(buckets, total)}<div class="source-totals">${Object.entries(buckets).map(([source, value]) =>
      `<div>${sourceChip(source)}<strong>${total === 0 ? "—" : percent(value / total)}</strong><small>${points(value)} pts</small></div>`).join("")}</div></div>
    <p class="coverage-note">Shares use net <strong>actual starter points</strong>, not bench points or team-total adjustments.
    Weekly team scores: <strong>${points(teamPoints)}</strong> · Difference from starter scores: <strong>${adjustment >= 0 ? "+" : ""}${points(adjustment)}</strong>.
    This difference is kept separate, never assigned to draft, trade, or free agency. Scored bye weeks are excluded.</p>
    <details class="acquisition-method"><summary>How attribution works &amp; why some points are unknown</summary>
    <p>Each start is credited to the franchise’s latest recorded acquisition before that start: draft, trade, or free agency (including waivers).
    That source carries across seasons; dropping and re-signing a player resets the source. Draft credit follows the roster receiving the pick, not the original draft slot. A traded draft pick is not a traded player.</p>
    <p>Sleeper starts look back to the original ESPN acquisition, even when only the Sleeper era is selected.
    Players are matched by native ESPN ID, or a unique normalized name plus position when that ID is absent, and franchises by the owner crosswalk.
    The 240-pick 2022 startup draft is an administrative import, not a new Draft acquisition. The actual 50-pick rookie draft still counts as Draft.
    Same-franchise commissioner placements and restorations retain the last source; a different-franchise commissioner addition stays Unknown.
    Later player trades, drops/re-signings, and real drafts replace the inherited source.</p>
    <p>We replay completed Sleeper transactions and real drafts from 2022 onward over that ESPN handoff.
    Retained players without a traceable acquisition, commissioner moves, conflicting timestamps, and uncertain in-week moves stay Unknown.</p>
    <p>Weekly starter exports do not include each player’s historical kickoff time. We therefore consider every ownership state within that week’s first-to-last NFL kickoff window.
    If more than one acquisition could explain a start on that roster, its source is Unknown. Moves after the last kickoff never change that week’s credit.
    Individual draft pick timestamps are also absent; a player move during that draft leaves provenance Unknown until a later unambiguous acquisition.</p>
    <p>ESPN exports include regular-season historical lineups and completed transactions from league and player-card history.
    When a completion timestamp is absent, we use a conservative interval from proposal until the next scoring week's first kickoff (or the next season for late-season records), never assume proposal order is execution order.
    Only a unique acquisition consistent with those intervals receives credit. ESPN keeper picks never reset a source to Draft:
    we look back through every prior season to the 2016 initial draft and preserve the latest recorded non-keeper acquisition.
    If no matching acquisition is available, keeper origins stay Unknown.
    Trades with no recoverable player legs are deliberately ignored, not used to invalidate other players' sources.
    Pre-2018 transaction records are incomplete, so carried sources reflect the best available history rather than guaranteed accuracy.
    Acquisition evidence can date to 2016 even though scored starts begin in 2018. The handoff uses completed ESPN history before the June 2022 import:
    real draft picks use draft completion, and completed transactions use execution time when present, otherwise proposal time as a best-effort ordering.
    This avoids treating administrative pre-draft additions as newer than the completed rookie draft. Unmatched or ambiguous players/franchises remain Unknown.
    Explicit zero-point ESPN starts without an actual stat row (such as NFL byes) are preserved and flagged in the evidence.</p>
    <p>Regular-season standings totals and weekly scores can differ. The cards use weekly scores for reconciliation and show the standings discrepancy separately.
    Negative player scores are retained; shares are signed net contributions and can fall outside 0–100% when a bucket or total is negative.</p></details>
    <details class="acquisition-method grade-method"><summary>How acquisition grades work</summary>
    <p><strong>Draft: A · Free agency (including waivers): A+.</strong> Unknown sources are N/A.
    Trades are graded separately for each receiving franchise, on the whole package rather than individual player performance.
    Each traded player receives that side's deal grade. Multiple trades for the same player appear separately.</p>
    <p>A trade's net return is the starter points its received assets earned for that franchise, minus the other team's return.
    In multi-team trades, each side is compared with the average return of the other teams, rounded to the nearest hundredth.
    Only covered regular-season starts count, through ${tradeGrades?.lastSeason ?? 2025}; ESPN origins carry into Sleeper.
    Credit ends when a player is dropped or traded. Bench scores, later free-agent re-signings, postseason and replacement trade assets do not count.
    Grades do not change with display filters and are to-date, not predictions of players' remaining careers.</p>
    <p><strong>A-:</strong> net gain of 100+ pts · <strong>B:</strong> between -100 and +100 pts (exclusive) ·
    <strong>C:</strong> loss of 100–249.99 pts · <strong>D:</strong> loss of 250–499.99 pts · <strong>F:</strong> loss of 500+ pts.
    B is centered on an even trade; A- is the ceiling. Bands use raw point margins, not percentages.</p>
    <p>A traded pick resolves by its original franchise, year and round. Once selected, we count that player's starter points while held.
    Trading the pick away before selection ends its direct return; we do not follow the replacement assets.
    Picks not yet made in this archive use the mean observed holding return for that rookie round, including zero-return selections.
    The baseline is the four completed Sleeper rookie drafts (2022–2025), excluding the startup import; older classes have more scoring history.
    Estimates are explicitly marked and will change when historical exports are refreshed.</p>
    ${tradeGrades ? `<p>Round estimates: ${tradeGrades.averages.map((average) =>
      `R${average.round}: <strong>${points(average.points)} pts</strong> (${average.count} picks)`).join(" · ")}.</p>` : ""}
    <p>These are best-effort grades using assigned acquisition evidence, not guaranteed complete lifetime returns.
    ESPN scoring begins in 2018 and missing trade/pick details are never filled with zero-value grades.
    Unresolved pick ownership and FAAB packages are N/A.</p></details>
    ${tradeLedger(tradeGrades, displayed, state, era, mode)}
    <h3 class="acquisition-list-title">The roster-building breakdown</h3>
    <p class="section-footnote">Tap a franchise for players, acquisition evidence, and score reconciliation. Percentages use the same starter-point denominator in every card.</p>
    <div class="acquisition-list">${displayed.map((group) => `<details class="acquisition-card"><summary><div class="acquisition-card-title">
    <strong>${e(group.name)}</strong><small>${points(group.points)} starter pts · ${group.starts} starts · ${group.seasons.size} seasons</small></div>
    <span class="acquisition-card-coverage">${group.coverage === null ? "—" : percent(group.coverage)} assigned<span aria-hidden="true"> +</span></span>
    ${sourceBar(group.buckets, group.points)}<div class="source-inline">${Object.entries(group.buckets).map(([source]) =>
      `<span>${sourceChip(source)} ${group.shares[source] === null ? "—" : percent(group.shares[source])}</span>`).join("")}</div></summary>
    <div class="acquisition-detail"><div class="detail-stats"><span>STARTER POINTS<strong>${points(group.points)}</strong></span>
    <span>WEEKLY TEAM POINTS<strong>${points(group.teamPoints)}</strong></span><span>TEAM ADJUSTMENT<strong>${group.adjustment >= 0 ? "+" : ""}${points(group.adjustment)}</strong></span>
    <span>UNRESOLVED POINTS<strong>${points(group.buckets.unknown)}</strong></span></div>
    ${group.standingPoints !== null ? `<p class="section-footnote">Regular-season standings PF: ${points(group.standingPoints)}.
    Standings minus weekly team scores: ${points(group.standingPoints - group.teamPoints)}.</p>` : ""}
    <div class="table-scroll"><table><caption class="sr-only">${e(group.name)} acquisition source players</caption><thead><tr>
    <th>Player</th><th>Source</th><th>Grade</th><th>Points</th><th>Share</th><th>Starts</th><th>Evidence</th></tr></thead><tbody>
    ${group.players.map((player) => `<tr><td><strong>${e(player.name)}</strong><small>${e(player.position)} · ${player.platform === "espn" ? "ESPN" : "Sleeper"}</small></td>
    <td>${sourceChip(player.source)}</td><td>${playerGrade(player, tradeGrades)}</td><td>${points(player.points)}</td><td>${group.points === 0 ? "—" : percent(player.points / group.points)}</td><td>${player.starts}</td>
    <td><details class="acquisition-evidence"><summary>View ${player.evidence.length} starts</summary><ul>
    ${[...player.evidence].sort((a, b) => b.season - a.season || b.week - a.week).map((entry) => `<li>
    <strong>${entry.season} W${entry.week} · ${points(entry.points)} pts</strong>
    ${entry.reportedZero ? "<span>ESPN reports 0 points; no actual stat row supplied.</span>" : ""}
    <span>${e(SOURCE_REASONS[entry.reason])}</span>${entry.event ?
      `<span>${entry.originPlatform === "espn" ? "ESPN origin · " : ""}${e(entry.kind)} · ${new Date(entry.acquiredAt).toISOString().slice(0, 10)}${entry.acquiredBefore && entry.acquiredBefore !== entry.acquiredAt ? ` to ${new Date(entry.acquiredBefore).toISOString().slice(0, 10)} (execution interval)` : ""} UTC · ${entry.acquiredSeason} season</span><code>${e(entry.event)}</code>${entry.reason === "migration" ? `<span>ESPN player ${e(entry.espnPlayer)} · ${entry.identityMatch === "espn-id" ? "native player ID match" : "unique name + position match"}</span>` : ""}` : ""}</li>`).join("")}
    </ul></details></td></tr>`).join("")}</tbody></table></div></div></details>`).join("")}</div>`;
}
