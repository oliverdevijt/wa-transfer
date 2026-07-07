// Core Data assigns each entity (table) a numeric Z_ENT id per compiled model.
// That id is NOT guaranteed stable across app versions, so it must always be
// resolved from the specific backup's own Z_PRIMARYKEY table, never hardcoded.

function getEntityIds(db) {
  const rows = db.prepare('SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY').all();
  const byName = {};
  for (const row of rows) byName[row.Z_NAME] = row.Z_ENT;
  return byName;
}

// Core Data uses Z_PRIMARYKEY.Z_MAX to allocate the next Z_PK for an entity.
// Leaving it stale after inserting new rows risks Z_PK collisions once the
// app itself creates rows again after a restore.
function bumpZMax(db, entityName, newMaxPk) {
  db.prepare('UPDATE Z_PRIMARYKEY SET Z_MAX = ? WHERE Z_NAME = ? AND Z_MAX < ?')
    .run(newMaxPk, entityName, newMaxPk);
}

module.exports = { getEntityIds, bumpZMax };
