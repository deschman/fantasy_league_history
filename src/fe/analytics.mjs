function key(season, team) {
  return `${season}:${team.trim()}`;
}

function cents(value) {
  if (value === null || value === undefined || String(value).trim() === "" || !Number.isFinite(Number(value))) {
    throw new Error("Missing or invalid weekly score");
  }
  return Math.round(Number(value) * 100);
}

function pairKey(week, home, away) {
  return `${week}:${[home, away].sort((a, b) => a - b).join(":")}`;
}

export function buildAnalytics(history, sources, details) {
  const teams = new Map(history.map((row) => [key(row.season, row.team), row]));
  const rosters = new Map();
  for (const source of sources) {
    if (source.platform !== "sleeper") continue;
    for (const row of source.crosswalk) {
      const team = teams.get(key(row.season, row.team));
      if (!team) throw new Error(`Unknown crosswalk team: ${row.team}`);
      const id = `${row.season}:${row.roster_id}`;
      if (rosters.has(id)) throw new Error(`Duplicate roster: ${id}`);
      rosters.set(id, team);
    }
  }
  const metadata = new Map();
  for (const season of details.seasons) {
    if (metadata.has(season.season)) throw new Error(`Duplicate detail season: ${season.season}`);
    const seasonTeams = history.filter((row) => row.season === season.season && row.platform === "sleeper");
    if (!seasonTeams.length || !seasonTeams.some((row) => row.finalRank === 1)) {
      throw new Error(`Details must reference a completed season: ${season.season}`);
    }
    if (!Number.isInteger(season.regularWeeks) || season.regularWeeks < 1 || season.lastWeek <= season.regularWeeks) {
      throw new Error(`Invalid season weeks: ${season.season}`);
    }
    metadata.set(season.season, season);
  }
  const games = [];
  const coverage = [];
  for (const season of [...new Set(history.map((row) => row.season))]) {
    const seasonTeams = history.filter((row) => row.season === season);
    const platform = seasonTeams[0].platform;
    const meta = metadata.get(season);
    if (platform === "sleeper" && !meta) throw new Error(`Missing Sleeper details for ${season}`);
    const regularWeeks = meta?.regularWeeks ?? seasonTeams[0].wins + seasonTeams[0].losses + seasonTeams[0].ties;
    const source = sources.find((entry) => entry.platform === platform);
    const seen = new Set();
    const titleGames = new Map();
    const playoffTeams = new Set();
    for (const roster of meta?.playoffRosters ?? []) {
      const team = rosters.get(`${season}:${roster}`);
      if (!team) throw new Error(`Unknown playoff roster: ${season}:${roster}`);
      playoffTeams.add(team);
    }
    for (const game of meta?.titleGames ?? []) {
      if (!playoffTeams.has(rosters.get(`${season}:${game.home}`)) ||
          !playoffTeams.has(rosters.get(`${season}:${game.away}`)) ||
          ![game.home, game.away].includes(game.winner) || game.week <= regularWeeks) {
        throw new Error(`Invalid title-bracket game in ${season}`);
      }
      const id = pairKey(game.week, game.home, game.away);
      if (titleGames.has(id)) throw new Error(`Duplicate title-bracket game in ${season}`);
      titleGames.set(id, game);
    }
    const rosterFor = new Map((source.crosswalk ?? []).map((row) => [key(row.season, row.team), Number(row.roster_id)]));
    const stats = new Map(seasonTeams.map((row) => [row, { wins: 0, losses: 0, ties: 0, pf: 0, pa: 0, weeks: new Set() }]));
    let excluded = 0;
    const verifiedTitles = new Set();
    const seasonGames = [];
    for (const raw of source.matchups.filter((row) => Number(row.season) === season)) {
      const week = Number(raw.week);
      if (!Number.isInteger(week) || week < 1) throw new Error(`Invalid matchup week in ${season}`);
      if (platform === "espn" && week > regularWeeks) {
        excluded++;
        continue;
      }
      if (meta && week > meta.lastWeek) throw new Error(`Unscored fixture in ${season}`);
      const home = teams.get(key(season, raw.home_team));
      const away = teams.get(key(season, raw.away_team));
      if (!home || !away || home === away) throw new Error(`Unknown or unpaired matchup in ${season} week ${week}`);
      const id = `${season}:${week}:${[home.team, away.team].sort().join("|")}`;
      if (seen.has(id)) throw new Error(`Duplicate matchup: ${id}`);
      seen.add(id);
      const homeScore = cents(raw.home_score);
      const awayScore = cents(raw.away_score);
      const bracketId = pairKey(week, rosterFor.get(key(season, home.team)), rosterFor.get(key(season, away.team)));
      const titleGame = titleGames.get(bracketId);
      if (titleGame) verifiedTitles.add(bracketId);
      const stage = week <= regularWeeks ? "regular" : titleGame ? "playoff" : "placement";
      const winner = titleGame ? rosters.get(`${season}:${titleGame.winner}`) :
        homeScore === awayScore ? null : homeScore > awayScore ? home : away;
      const game = { id, season, week, platform, home, away, homeScore, awayScore, stage, winner,
        margin: Math.abs(homeScore - awayScore), total: homeScore + awayScore };
      seasonGames.push(game);
      if (stage === "regular") {
        for (const [team, score, against] of [[home, homeScore, awayScore], [away, awayScore, homeScore]]) {
          const tally = stats.get(team);
          if (tally.weeks.has(week)) throw new Error(`Multiple regular games in ${season} week ${week}: ${team.team}`);
          tally.weeks.add(week);
          tally.wins += score > against ? 1 : 0;
          tally.losses += score < against ? 1 : 0;
          tally.ties += score === against ? 1 : 0;
          tally.pf += score;
          tally.pa += against;
        }
      }
    }
    if (verifiedTitles.size !== titleGames.size) throw new Error(`Missing title-bracket weekly scores in ${season}`);
    const notes = [];
    for (const [team, statsForTeam] of stats) {
      if (statsForTeam.weeks.size !== regularWeeks || statsForTeam.wins !== team.wins ||
          statsForTeam.losses !== team.losses || statsForTeam.ties !== team.ties) {
        throw new Error(`Weekly records do not reconcile for ${season}: ${team.team}`);
      }
      if (statsForTeam.pf !== cents(team.pointsFor) || statsForTeam.pa !== cents(team.pointsAgainst)) {
        notes.push(`${team.team}: weekly PF/PA ${(statsForTeam.pf / 100).toFixed(2)}/${(statsForTeam.pa / 100).toFixed(2)} differs from roster totals.`);
      }
    }
    games.push(...seasonGames);
    coverage.push({ season, platform, regularWeeks, regularGames: seasonGames.filter((game) => game.stage === "regular").length,
      playoffGames: verifiedTitles.size, excluded, notes, playoffTeams: [...playoffTeams] });
  }
  const starters = [];
  const drafts = [];
  const starterKeys = new Set();
  for (const meta of metadata.values()) {
    if (!meta.starters.length || !meta.drafts.length) {
      throw new Error(`Missing starter or draft data for ${meta.season}`);
    }
    for (const [week, roster, player, points] of meta.starters) {
      const team = rosters.get(`${meta.season}:${roster}`);
      const info = details.players[player];
      const id = `${meta.season}:${week}:${roster}:${player}`;
      if (!team || !info?.name || !info.position || !Number.isInteger(week) || week < 1 || week > meta.lastWeek ||
          starterKeys.has(id)) throw new Error(`Invalid or duplicate starter entry: ${id}`);
      starterKeys.add(id);
      const game = games.find((game) => game.season === meta.season && game.week === week && [game.home, game.away].includes(team));
      starters.push({ season: meta.season, week, platform: "sleeper", team, player, ...info,
        points: cents(points), stage: week <= meta.regularWeeks ? "regular" : game?.stage ?? "bye" });
    }
    for (const draft of meta.drafts) {
      const picks = [];
      const seen = new Set();
      for (const pick of draft.picks) {
        const team = rosters.get(`${meta.season}:${pick.roster}`);
        if (!team || !pick.name || !pick.position || !Number.isInteger(pick.pick) || pick.pick < 1 ||
            !Number.isInteger(pick.round) || pick.round < 1 || seen.has(pick.pick)) {
          throw new Error(`Invalid draft pick in ${meta.season}: ${draft.id}`);
        }
        seen.add(pick.pick);
        picks.push({ ...pick, team });
      }
      drafts.push({ ...draft, season: meta.season, platform: "sleeper", picks });
    }
  }
  return { games, coverage, starters, drafts };
}

export function selectGames(games, era = "all", scope = "regular") {
  return games.filter((game) => (era === "all" || game.platform === era) &&
    (scope === "all" || game.stage === scope));
}

export function rivalries(games, mode = "franchise") {
  const pairs = new Map();
  for (const game of games) {
    const people = [game.home[mode], game.away[mode]].sort((a, b) => a.id.localeCompare(b.id));
    const id = people.map((person) => person.id).join("|");
    if (people[0].id === people[1].id) throw new Error("A franchise cannot play itself");
    if (!pairs.has(id)) pairs.set(id, { id, a: people[0], b: people[1], aWins: 0, bWins: 0, ties: 0,
      aPoints: 0, bPoints: 0, games: [] });
    const pair = pairs.get(id);
    const homeIsA = game.home[mode].id === pair.a.id;
    pair.aPoints += homeIsA ? game.homeScore : game.awayScore;
    pair.bPoints += homeIsA ? game.awayScore : game.homeScore;
    if (game.winner === null) pair.ties++;
    else if (game.winner[mode].id === pair.a.id) pair.aWins++;
    else pair.bWins++;
    pair.games.push(game);
  }
  return [...pairs.values()].map((pair) => ({ ...pair,
    games: pair.games.sort((a, b) => b.season - a.season || b.week - a.week) }));
}

export function suggestedRivalries(pairs) {
  const candidates = pairs.filter((pair) => pair.games.length >= 4).sort((a, b) =>
    Math.abs(a.aWins - a.bWins) / a.games.length - Math.abs(b.aWins - b.bWins) / b.games.length ||
    b.games.length - a.games.length || a.id.localeCompare(b.id));
  const used = new Set();
  return candidates.filter((pair) => {
    if (used.has(pair.a.id) || used.has(pair.b.id)) return false;
    used.add(pair.a.id);
    used.add(pair.b.id);
    return true;
  });
}

export function highlightGames(games, category) {
  const entries = games.flatMap((game) => category === "score" || category === "low" ?
    [{ game, team: game.home, score: game.homeScore }, { game, team: game.away, score: game.awayScore }] :
    [{ game, team: game.winner, score: category === "total" ? game.total : game.margin }]);
  return entries.filter((entry) => category !== "close" || entry.game.margin > 0).sort((a, b) =>
    (category === "close" || category === "low" ? a.score - b.score : b.score - a.score) ||
    b.game.season - a.game.season || b.game.week - a.game.week || a.game.id.localeCompare(b.game.id));
}

export function playerMVPs(starters, mode = "franchise", manager = "", position = "", minimum = 1, sort = "points") {
  const groups = new Map();
  for (const entry of starters) {
    if ((manager && entry.team[mode].id !== manager) || (position && entry.position !== position)) continue;
    if (!groups.has(entry.player)) groups.set(entry.player, { player: entry.player, name: entry.name, position: entry.position,
      points: 0, starts: 0, best: -Infinity, seasons: new Set(), managers: new Set() });
    const group = groups.get(entry.player);
    group.points += entry.points;
    group.starts++;
    group.best = Math.max(group.best, entry.points);
    group.seasons.add(entry.season);
    group.managers.add(entry.team[mode].name);
  }
  return [...groups.values()].filter((group) => group.starts >= minimum).map((group) => ({
    ...group, average: group.points / group.starts,
    seasons: [...group.seasons].sort(), managers: [...group.managers].sort(),
  })).sort((a, b) => b[sort] - a[sort] || b.points - a.points || a.name.localeCompare(b.name));
}

export function playoffResume(person, coverage, games, mode = "franchise") {
  const seasons = coverage.filter((season) => season.playoffTeams.some((team) => team[mode].id === person));
  const played = games.filter((game) => game.stage === "playoff" && [game.home, game.away].some((team) => team[mode].id === person));
  const wins = played.filter((game) => game.winner?.[mode].id === person).length;
  return { appearances: seasons.length, wins, losses: played.length - wins };
}
