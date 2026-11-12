import { aggregate } from "./history.mjs";
import { selectGames, rivalries, suggestedRivalries, highlightGames, playerMVPs, playerPerformances } from "./analytics.mjs";
import { escapeHTML as e, number, record, sectionHeading } from "./ui.mjs";

const points = (value) => number(value / 100, 2);
const stageName = (stage) => ({ regular: "Regular season", playoff: "Title bracket", placement: "Placement / consolation", bye: "Bye" }[stage]);
const option = (value, label, selected) => `<option value="${e(value)}" ${String(value) === String(selected) ? "selected" : ""}>${e(label)}</option>`;
function managerSelect(id, label, managers, selected, all = false) {
  return `<label>${label}<select id="${id}">${all ? option("", "All managers", selected) : ""}
    ${managers.map((manager) => option(manager.id, manager.name, selected)).join("")}</select></label>`;
}
function scopeControl(scope) {
  return `<label>Games<select id="scope">${option("regular", "Regular season", scope)}
    ${option("playoff", "Verified title bracket", scope)}${option("all", "All recorded games incl. placement", scope)}</select></label>`;
}
function coverageNote(context) {
  const { analytics, era } = context;
  const coverage = analytics.coverage.filter((row) => era === "all" || row.platform === era);
  return `<p class="coverage-note">Completed seasons only. ${coverage.map((row) =>
    `${row.season}: ${row.regularGames} regular games${row.platform === "sleeper" ? `, ${row.playoffGames} verified title-bracket games` :
      "; postseason classification unavailable"}`).join(" · ")}. Placement games are not title-bracket wins.</p>`;
}
function gameButton(game, text = "View matchup") {
  return `<button type="button" class="text-button" data-game="${e(game.id)}">${text}</button>`;
}
function gamesTable(games, mode) {
  if (!games.length) return `<p class="empty">No games recorded for this selection.</p>`;
  return `<div class="table-scroll"><table><caption class="sr-only">Historical games</caption><thead><tr>
    <th>Season / week</th><th>Matchup</th><th>Score</th><th>Type</th><th>Details</th></tr></thead><tbody>
    ${games.map((game) => `<tr><td>${game.season} · W${game.week}</td><td><strong>${e(game.home[mode].name)}</strong>
      <small>vs ${e(game.away[mode].name)}</small></td><td>${points(game.homeScore)} – ${points(game.awayScore)}</td>
      <td>${stageName(game.stage)}</td><td>${gameButton(game)}</td></tr>`).join("")}</tbody></table></div>`;
}
function gameDetail(context) {
  const { analytics, state, mode, era } = context;
  const game = analytics.games.find((entry) => entry.id === state.game && (era === "all" || entry.platform === era));
  if (!game) return "";
  return `<section class="game-detail" aria-label="Selected matchup"><div class="card-top">
    <span class="eyebrow accent">${game.season} · WEEK ${game.week} · ${stageName(game.stage)}</span>
    <button type="button" class="text-button" data-close-game="true">Close matchup</button></div>
    <div class="scoreboard">${[[game.home, game.homeScore], [game.away, game.awayScore]].map(([team, score]) =>
      `<div><h3>${e(team[mode].name)}</h3><p>${e(team.team)}</p><strong>${points(score)}</strong></div>`).join('<span class="versus">VS</span>')}</div>
    <p>${game.winner ? `${e(game.winner[mode].name)} won` : "Tied game"} · Margin ${points(game.margin)} · Combined ${points(game.total)}</p>
    ${game.home.owner.id !== game.home.franchise.id || game.away.owner.id !== game.away.franchise.id ?
      `<p>Actual owners: ${e(game.home.owner.name)} vs ${e(game.away.owner.name)}</p>` : ""}</section>`;
}
function rivalryView(context) {
  const { analytics, state, rows, mode, era } = context;
  const managers = aggregate(rows, mode).sort((a, b) => a.name.localeCompare(b.name));
  const games = selectGames(analytics.games, era, state.scope);
  const pairs = rivalries(games, mode);
  if (!managers.some((manager) => manager.id === state.rivalA)) state.rivalA = managers[0].id;
  if (!managers.some((manager) => manager.id === state.rivalB) || state.rivalB === state.rivalA) {
    state.rivalB = managers.find((manager) => manager.id !== state.rivalA)?.id;
  }
  const a = managers.find((manager) => manager.id === state.rivalA);
  const b = managers.find((manager) => manager.id === state.rivalB);
  const selected = pairs.find((pair) => [pair.a.id, pair.b.id].includes(a.id) && [pair.a.id, pair.b.id].includes(b?.id));
  const aFirst = selected?.a.id === a.id;
  const series = selected ? `${aFirst ? selected.aWins : selected.bWins}–${aFirst ? selected.bWins : selected.aWins}–${selected.ties}` : "No meetings";
  const recommendations = suggestedRivalries(pairs);
  const compareButton = (pair, text) => `<button type="button" class="text-button" data-rival-a="${e(pair.a.id)}" data-rival-b="${e(pair.b.id)}">${text}</button>`;
  return sectionHeading("SETTLE THE DEBATE", "Rivalries", "Every head-to-head result, with franchise and actual-owner attribution.") +
    `<div class="feature-controls">${scopeControl(state.scope)}${managerSelect("rivalA", "Manager A", managers, a.id)}
    ${managerSelect("rivalB", "Manager B", managers.filter((manager) => manager.id !== a.id), b?.id)}</div>
    <div class="season-banner"><div><h3>${e(a.name)} vs ${e(b?.name ?? "—")}</h3>
    <p>Series A–B–ties · ${selected?.games.length ?? 0} games</p></div><strong class="record-value">${series}</strong></div>
    ${selected ? `<p class="section-footnote">Points: ${e(a.name)} ${points(aFirst ? selected.aPoints : selected.bPoints)} · ${e(b.name)} ${points(aFirst ? selected.bPoints : selected.aPoints)}</p>` : ""}
    <h3>Recent meetings</h3>${gamesTable(selected?.games.slice(0, 10) ?? [], mode)}
    <h3>Competitive pairings</h3><p class="section-footnote">Greedy suggestions: at least four meetings, closest win balance first, then most meetings. Each manager appears at most once; this is not an exhaustive matching.</p>
    <div class="records-grid">${recommendations.map((pair) => `<article class="record-card"><h3>${e(pair.a.name)} vs ${e(pair.b.name)}</h3>
    <p>${pair.aWins}–${pair.bWins}–${pair.ties} · ${pair.games.length} games</p>${compareButton(pair, "Compare rivalry")}</article>`).join("") || '<p class="empty">Not enough meetings for recommendations.</p>'}</div>
    <h3>Head-to-head matrix</h3><p class="section-footnote">Row manager's wins–losses–ties. Select a cell to compare. Horizontally scroll for all managers.</p>
    <div class="table-scroll"><table class="rivalry-matrix"><caption class="sr-only">Row manager head-to-head records</caption><thead><tr><th>Manager</th>
    ${managers.map((manager) => `<th>${e(manager.name)}</th>`).join("")}</tr></thead><tbody>${managers.map((manager) =>
      `<tr><th scope="row">${e(manager.name)}</th>${managers.map((opponent) => {
        if (manager.id === opponent.id) return "<td>—</td>";
        const pair = pairs.find((entry) => [entry.a.id, entry.b.id].includes(manager.id) && [entry.a.id, entry.b.id].includes(opponent.id));
        if (!pair) return "<td>No games</td>";
        const wins = pair.a.id === manager.id ? pair.aWins : pair.bWins;
        const losses = pair.a.id === manager.id ? pair.bWins : pair.aWins;
        return `<td class="${wins > losses ? "winning" : wins < losses ? "losing" : ""}">
          <button type="button" class="text-button" data-rival-a="${e(manager.id)}" data-rival-b="${e(opponent.id)}"
          aria-label="${e(manager.name)} vs ${e(opponent.name)}: ${wins} wins, ${losses} losses, ${pair.ties} ties">${wins}–${losses}–${pair.ties}</button></td>`;
      }).join("")}</tr>`).join("")}</tbody></table></div>${coverageNote(context)}`;
}

function highlightsView(context) {
  const { analytics, state, mode, era } = context;
  const games = selectGames(analytics.games, era, state.scope);
  const labels = { score: "Highest weekly scores", low: "Lowest weekly scores", blowout: "Biggest blowouts",
    close: "Closest finishes (non-ties)", total: "Highest combined scores" };
  const entries = highlightGames(games, state.category).slice(0, 10);
  return sectionHeading("GAMES WE STILL TALK ABOUT", "Game highlights", "The nail-biters, the blowouts, and the scoreboard breakers.") +
    `<div class="feature-controls">${scopeControl(state.scope)}<label>Record<select id="category">
    ${Object.entries(labels).map(([value, label]) => option(value, label, state.category)).join("")}</select></label></div>
    <p class="section-footnote">Top ten entries. Zero and negative scores are retained when recorded in a completed game. Ties in records use most recent season/week, then matchup ID. Scores use integer hundredths.</p>
    <div class="table-scroll"><table><caption class="sr-only">${labels[state.category]}</caption><thead><tr><th>Rank</th><th>Manager</th><th>Value</th><th>Game</th></tr></thead>
    <tbody>${entries.map((entry, index) => `<tr><td>${index + 1}</td><td><strong>${entry.team ? e(entry.team[mode].name) : "Both managers"}</strong>
    <small>${entry.game.season} · W${entry.game.week} · ${stageName(entry.game.stage)}</small></td><td>${points(entry.score)}</td>
    <td>${gameButton(entry.game, `${e(entry.game.home[mode].name)} vs ${e(entry.game.away[mode].name)}`)}</td></tr>`).join("")}</tbody></table></div>
    ${!entries.length ? '<p class="empty">No games in this selection.</p>' : ""}${coverageNote(context)}`;
}

function awardsView(context) {
  const { analytics, rows, mode, era } = context;
  const groups = aggregate(rows, mode);
  const games = selectGames(analytics.games, era, "regular");
  const award = (title, label, candidates, metric, describe) => {
    const best = Math.max(...candidates.map(metric));
    const winners = candidates.filter((candidate) => metric(candidate) === best);
    return `<article class="record-card"><span class="eyebrow">${title}</span><h3>${label}</h3>
      ${winners.map(describe).join("")}</article>`;
  };
  const careerAwards = [
    ["The Ring Collector", "Most championships", "titles"],
    ["The Win Hoarder", "Most regular-season wins", "wins"],
    ["The Unbreakable Attendance Award", "Most regular-season losses", "losses"],
    ["Always the Bridesmaid", "Most runner-up finishes", "runnerUps"],
  ].map(([title, label, metric]) => award(title, label, groups.map((group) => ({ ...group, runnerUps: group.finals - group.titles })),
    (group) => group[metric], (group) => `<p><strong>${e(group.name)}</strong> · ${group[metric]}</p>`)).join("");
  const weeklyAwards = [
    ["The Scoreboard Breaker", "Highest weekly score", "score"],
    ["The Mercy Rule", "Largest winning margin", "blowout"],
    ["The Photo Finish", "Smallest non-zero winning margin", "close"],
  ].map(([title, label, category]) => {
    const entries = highlightGames(games, category);
    if (!entries.length) return "";
    const winners = entries.filter((entry) => entry.score === entries[0].score);
    return `<article class="record-card"><span class="eyebrow">${title}</span><h3>${label}</h3>
      ${winners.map((entry) => `<p><strong>${e(entry.team?.[mode].name ?? "Tied game")}</strong> · ${points(entry.score)}</p>
      ${gameButton(entry.game, `${entry.game.season} · W${entry.game.week}`)}`).join("")}</article>`;
  }).join("");
  const pairs = rivalries(games, mode).filter((pair) => pair.games.length >= 4 && pair.ties === 0 && (!pair.aWins || !pair.bWins));
  const curse = pairs.length ? award("The Kryptonite Award", "Longest undefeated series (minimum four meetings)", pairs,
    (pair) => pair.games.length, (pair) => `<p><strong>${e(pair.aWins ? pair.a.name : pair.b.name)}</strong> over
    ${e(pair.aWins ? pair.b.name : pair.a.name)} · ${pair.games.length}–0</p>`) : "";
  return sectionHeading("THE LEAGUE AWARDS", "Bragging rights", "Lighthearted, data-driven awards. All co-holders are shown; regular-season games only.") +
    `<div class="records-grid">${careerAwards}${weeklyAwards}${curse}</div>${coverageNote(context)}`;
}

function playersView(context) {
  const { analytics, rows, state, mode, era } = context;
  const starters = analytics.starters.filter((entry) => (era === "all" || entry.platform === era) &&
    (state.scope === "all" || entry.stage === state.scope));
  if (!starters.length) return sectionHeading("THE PLAYERS BEHIND THE POINTS", "Player MVPs") +
    '<p class="empty">Starter-level data is available for Sleeper 2022–2025 only. Select Sleeper or All platforms. ESPN starter data has not been exported.</p>';
  const managers = aggregate(rows.filter((row) => row.platform === "sleeper"), mode).sort((a, b) => a.name.localeCompare(b.name));
  if (state.playerManager && !managers.some((manager) => manager.id === state.playerManager)) state.playerManager = "";
  const positions = [...new Set(starters.map((entry) => entry.position))].sort();
  const singleGame = state.playerSort === "single";
  const players = singleGame ? [] : playerMVPs(starters, mode, state.playerManager, state.position, Number(state.minStarts), state.playerSort);
  const performances = singleGame ? playerPerformances(starters, mode, state.playerManager, state.position) : [];
  const cutoff = performances[49]?.points ?? -Infinity;
  const leaders = performances.filter((entry, index) => index < 50 || entry.points === cutoff);
  return sectionHeading("THE PLAYERS BEHIND THE POINTS", "Player MVPs", "Sleeper 2022–2025 only. Points count only when a player was actually started, not on the bench.") +
    `<div class="feature-controls">${scopeControl(state.scope)}
    ${managerSelect("playerManager", "Manager", managers, state.playerManager, true)}
    <label>Position<select id="position">${option("", "All positions", state.position)}${positions.map((position) => option(position, position, state.position)).join("")}</select></label>
    ${!singleGame ? `<label>Minimum starts<select id="minStarts">${[1, 5, 10, 20].map((value) => option(value, value, state.minStarts)).join("")}</select></label>` : ""}
    <label>Rank by<select id="playerSort">${option("points", "Starter points", state.playerSort)}${option("average", "Points per start", state.playerSort)}${option("single", "Single-game performances", state.playerSort)}</select></label></div>
    <p class="section-footnote">All recorded games includes scored bye weeks; title-bracket scope excludes placement games and byes. Player points do not incorporate commissioner overrides to the team total. Current player names/positions come from Sleeper’s player index.</p>
    ${singleGame ? `<h3>Highest single-game player scores</h3>
    <p class="section-footnote">Top 50 performances, including all ties at the cutoff. Equal scores share a rank; tied entries show most recent season/week first. A player can appear more than once. Minimum starts does not apply.</p>
    <div class="table-scroll"><table><caption class="sr-only">Single-game player performances</caption><thead><tr>
    <th>Rank</th><th>Player</th><th>Points</th><th>Manager</th><th>Season</th><th>Week</th><th>Type</th></tr></thead><tbody>
    ${leaders.map((entry) => `<tr><td>${performances.findIndex((performance) => performance.points === entry.points) + 1}</td>
    <td><strong>${e(entry.name)}</strong><small>${e(entry.position)}</small></td><td>${points(entry.points)}</td>
    <td>${e(entry.team[mode].name)}<small>${e(entry.team.team)}</small></td><td>${entry.season}</td><td>${entry.week}</td>
    <td>${stageName(entry.stage)}</td></tr>`).join("")}</tbody></table></div>
    ${!leaders.length ? '<p class="empty">No performances meet these filters.</p>' : ""}` : `
    <div class="table-scroll"><table><caption class="sr-only">Player MVP rankings</caption><thead><tr>
    <th>Rank</th><th>Player</th><th>Points</th><th>Starts</th><th>Pts/start</th><th>Best week</th><th>Seasons</th><th>Managers</th></tr></thead><tbody>
    ${players.map((player, index) => `<tr><td>${index + 1}</td><td><strong>${e(player.name)}</strong><small>${e(player.position)}</small></td>
    <td>${points(player.points)}</td><td>${player.starts}</td><td>${points(player.average)}</td><td>${points(player.best)}</td>
    <td>${player.seasons.join(", ")}</td><td>${player.managers.map(e).join(", ")}</td></tr>`).join("")}</tbody></table></div>
    ${!players.length ? '<p class="empty">No players meet these filters.</p>' : ""}`}`;
}

function draftsView(context) {
  const { analytics, rows, state, mode, era } = context;
  const drafts = analytics.drafts.filter((draft) => era === "all" || draft.platform === era);
  if (!drafts.length) return sectionHeading("BUILDING THE ROSTER", "Draft history") +
    '<p class="empty">Draft exports cover Sleeper 2022–2025. ESPN draft history has not been exported.</p>';
  const seasons = [...new Set(drafts.map((draft) => draft.season))].sort((a, b) => b - a);
  if (!seasons.includes(Number(state.draftSeason))) state.draftSeason = seasons[0];
  const managers = aggregate(rows.filter((row) => row.platform === "sleeper"), mode).sort((a, b) => a.name.localeCompare(b.name));
  if (state.draftManager && !managers.some((manager) => manager.id === state.draftManager)) state.draftManager = "";
  const query = state.draftQuery.toLowerCase();
  return sectionHeading("BUILDING THE ROSTER", "Draft history", "Sleeper 2022–2025. Original picks, receiving rosters, and keeper flags; no inferred draft value.") +
    `<div class="feature-controls"><label>Season<select id="draftSeason">${seasons.map((season) => option(season, season, state.draftSeason)).join("")}</select></label>
    ${managerSelect("draftManager", "Manager", managers, state.draftManager, true)}
    <label>Player search<input id="draftQuery" type="search" value="${e(state.draftQuery)}" placeholder="Search a drafted player"></label></div>
    ${drafts.filter((draft) => draft.season === Number(state.draftSeason)).map((draft) => {
      const picks = draft.picks.filter((pick) => (!state.draftManager || pick.team[mode].id === state.draftManager) && pick.name.toLowerCase().includes(query));
      return `<section class="draft-section"><h3>${draft.season} · ${e(draft.type)} draft · ${draft.picks.length} picks</h3>
      <p class="section-footnote">Draft ID ${e(draft.id)}. Manager is the roster receiving the pick, not necessarily its original draft slot.</p>
      ${!draft.picks.length ? '<p class="coverage-note">Sleeper marks this draft complete but returns no picks. It is not counted as a played draft.</p>' :
        `<div class="table-scroll"><table><caption class="sr-only">Draft ${e(draft.id)}</caption><thead><tr>
        <th>Pick</th><th>Player</th><th>Position</th><th>Round</th><th>Manager</th><th>Keeper</th></tr></thead><tbody>
        ${picks.sort((a, b) => a.pick - b.pick).map((pick) => `<tr><td>${pick.pick}</td><td><strong>${e(pick.name)}</strong></td>
        <td>${e(pick.position)}</td><td>${pick.round}</td><td>${e(pick.team[mode].name)}</td><td>${pick.keeper ? "Yes" : "No"}</td></tr>`).join("")}
        </tbody></table></div>${!picks.length ? '<p class="empty">No picks match these filters.</p>' : ""}`}</section>`;
    }).join("")}`;
}

function auditView(context) {
  const { analytics, era } = context;
  return sectionHeading("SHOW YOUR WORK", "Data coverage", "Verified coverage and source discrepancies, so missing data never masquerades as zero.") +
    `<div class="table-scroll"><table><caption class="sr-only">Historical data coverage</caption><thead><tr><th>Season</th><th>Platform</th>
    <th>Regular games</th><th>Title games</th><th>Starter rows</th><th>Draft picks</th></tr></thead><tbody>
    ${analytics.coverage.filter((row) => era === "all" || row.platform === era).map((row) => `<tr><td>${row.season}</td><td>${row.platform.toUpperCase()}</td>
    <td>${row.regularGames}</td><td>${row.platform === "sleeper" ? row.playoffGames : "Not classified"}</td>
    <td>${row.platform === "sleeper" ? analytics.starters.filter((entry) => entry.season === row.season).length : "Unavailable"}</td>
    <td>${row.platform === "sleeper" ? analytics.drafts.filter((entry) => entry.season === row.season).reduce((sum, draft) => sum + draft.picks.length, 0) : "Unavailable"}</td></tr>`).join("")}</tbody></table></div>
    <h3>Validation and limitations</h3><ul class="audit-notes"><li>Every regular-season team record reconciles with the weekly games. ESPN 2016–2021 weekly points also reconcile exactly.</li>
    <li>Sleeper title wins use bracket winners, including any official tiebreaker. Byes and placement/consolation games do not count as title wins. Bracket classification currently covers 2022–2025 only.</li>
    <li>ESPN postseason rows are excluded: the CSV does not distinguish byes, multi-week rounds, and placement games. Finish alone cannot prove wins or byes. ESPN playoff wins/appearances are unknown, not zero.</li>
    <li>Starter points use actual starter scores, not team totals. Team score overrides and scoring changes across years can affect comparisons.</li>
    ${era !== "espn" ? "<li>One empty 2022 draft is retained with a warning; the two populated 2022 drafts have 290 picks in total.</li>" : ""}
    ${analytics.coverage.filter((row) => era === "all" || row.platform === era).flatMap((row) => row.notes.map((note) => `<li>${row.season}: ${e(note)}</li>`)).join("")}
    </ul>`;
}

export function renderFeature(view, context) {
  const renderers = { rivalries: rivalryView, highlights: highlightsView, awards: awardsView,
    players: playersView, drafts: draftsView, audit: auditView };
  return renderers[view](context) + gameDetail(context);
}
