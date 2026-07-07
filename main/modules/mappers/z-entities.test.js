const test = require('node:test');
const assert = require('node:assert/strict');
const { getEntityIds, bumpZMax } = require('./z-entities');

function fakeDb(primaryKeyRows) {
  const rows = primaryKeyRows.map(r => ({ ...r }));
  return {
    prepare(sql) {
      if (sql.includes('SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY')) {
        return { all: () => rows };
      }
      if (sql.startsWith('UPDATE Z_PRIMARYKEY')) {
        return {
          run: (newMaxPk, entityName) => {
            const row = rows.find(r => r.Z_NAME === entityName);
            if (row && row.Z_MAX < newMaxPk) row.Z_MAX = newMaxPk;
          },
        };
      }
      throw new Error(`Unexpected SQL in fakeDb: ${sql}`);
    },
  };
}

test('getEntityIds maps Z_NAME to Z_ENT', () => {
  const db = fakeDb([
    { Z_ENT: 4, Z_NAME: 'WAChatSession', Z_MAX: 48 },
    { Z_ENT: 9, Z_NAME: 'WAMessage', Z_MAX: 164 },
  ]);
  const ids = getEntityIds(db);
  assert.equal(ids.WAChatSession, 4);
  assert.equal(ids.WAMessage, 9);
});

test('bumpZMax raises Z_MAX only when the new value is higher', () => {
  const db = fakeDb([{ Z_ENT: 9, Z_NAME: 'WAMessage', Z_MAX: 164 }]);
  bumpZMax(db, 'WAMessage', 200);
  const ids = db.prepare('SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY').all();
  assert.equal(ids[0].Z_MAX, 200);
  bumpZMax(db, 'WAMessage', 50); // lower — must not decrease it
  assert.equal(db.prepare('SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY').all()[0].Z_MAX, 200);
});
