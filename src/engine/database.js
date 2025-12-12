const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Pfad zur DB: Zwei Ordner hoch (aus src/engine/ raus)
const dbPath = path.resolve(__dirname, '../../escape.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT, ip TEXT, last_seen INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, json_data TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS puzzle_solutions (puzzle_id INTEGER PRIMARY KEY, solution TEXT, updated_at INTEGER)`);
});

module.exports = {
    get: (sql, params) => new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    }),
    all: (sql, params) => new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    }),
    run: (sql, params) => new Promise((resolve, reject) => {
        db.run(sql, params, function(err) { err ? reject(err) : resolve(this); });
    })
};
