// server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require('ws');
const mysql = require("mysql2");
const helmet = require("helmet");

const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || '')
    .split(',').map(s => s.trim()).filter(Boolean);

const app = express();
app.use(helmet());
const server = http.createServer(app);

const wss = new WebSocket.Server({
    server,
    perMessageDeflate: true, // compress JSON frames — helps a lot on slow (2G) links
    verifyClient: ({ origin }) => {
        if (!origin) return true; // allow non-browser clients (timing app)
        if (ALLOWED_ORIGINS.length === 0) return true; // no restriction if not configured
        return ALLOWED_ORIGINS.includes(origin);
    }
});

app.use(express.static(__dirname + '/public'));

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    connectionLimit: 25
});

// Test DB connection
db.getConnection((err, conn) => {
    if (err) {
        console.error("❌ MYSQL ERROR:", err);
        process.exit(1);
    }
    console.log("✅ MySQL connected");
    conn.release();
});

// Active riders — uses created_at (auto-set on insert) as the canonical
// start reference so both Start and Finish devices show the same elapsed time.
function queryOnTrack(cb) {
    const sql =
        'SELECT rider_id, name, team, category, stage, created_at ' +
        'FROM riders_on_track ORDER BY created_at';
    db.query(sql, (err, rows) => {
        if (err) { console.error('on_track query error:', err.message); cb([]); return; }
        cb(rows || []);
    });
}

// Riders who have finished a stage — returns diff_time for display.
function queryFinishedRiders(stage, cb) {
    const sql =
        'SELECT t.rider_id, r.name, r.team, r.category, t.stage, t.diff_time ' +
        'FROM 25_times t ' +
        'JOIN 25_riders r ON r.id = t.rider_id ' +
        'WHERE t.stage = ? AND t.diff_time IS NOT NULL';
    db.query(sql, [stage], (err, rows) => {
        if (err) { console.error('finished_riders query error:', err.message); cb([]); return; }
        cb(rows || []);
    });
}

function sendFinishedRiders(client, stage) {
    queryFinishedRiders(stage, (rows) => {
        if (client.readyState === WebSocket.OPEN)
            client.send(JSON.stringify({ type: 'finished_riders', data: rows }));
    });
}

// Every finished result across all stages/categories — for the results
// viewer, grouped client-side by category then stage.
function queryAllResults(cb) {
    const sql =
        'SELECT t.rider_id, r.rider_no, r.name, r.team, r.category, t.stage, t.diff_time ' +
        'FROM 25_times t ' +
        'JOIN 25_riders r ON r.id = t.rider_id ' +
        'WHERE t.diff_time IS NOT NULL ' +
        'ORDER BY r.category, t.stage, t.diff_time';
    db.query(sql, (err, rows) => {
        if (err) { console.error('all_results query error:', err.message); cb([]); return; }
        cb(rows || []);
    });
}

function sendAllResults(client) {
    queryAllResults((rows) => {
        if (client.readyState === WebSocket.OPEN)
            client.send(JSON.stringify({ type: 'all_results', data: rows }));
    });
}

function broadcastFinishedRiders(stage) {
    queryFinishedRiders(stage, (rows) => {
        const payload = JSON.stringify({ type: 'finished_riders', data: rows });
        wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(payload); });
    });
}

function broadcastAllResults() {
    queryAllResults((rows) => {
        const payload = JSON.stringify({ type: 'all_results', data: rows });
        wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(payload); });
    });
}

function sendOnTrack(client) {
    queryOnTrack((rows) => {
        if (client.readyState === WebSocket.OPEN)
            client.send(JSON.stringify({ type: 'riders_on_track', data: rows }));
    });
}

function broadcastOnTrack() {
    queryOnTrack((rows) => {
        const payload = JSON.stringify({ type: 'riders_on_track', data: rows });
        wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(payload); });
    });
}

// Confirm delivery of a single timing event back to the device that sent it.
// The device keeps every capture in a persistent outbox and only deletes it
// once this ack arrives, so a dropped/half-open socket costs a retry rather
// than a lost rider time. Retries are safe: 25_times has a unique key on
// (rider_id, stage), so a replay can never create a duplicate row.
function ackEvent(ws, eventId) {
    if (!eventId) return;               // legacy client — nothing to confirm
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'ack', event_id: eventId }));
}

wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', (message) => {
        const msg = message.toString();
        console.log('Received:', msg);

        try {
            const data = JSON.parse(msg);

            switch (data.action) {

                case 'ping': // ping pong
                    // Reply ONLY to the sender. Broadcasting the pong let one
                    // device's ping satisfy every other device's heartbeat,
                    // masking a dead/half-open socket — the exact condition
                    // that silently dropped timing events.
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'pong',
                            timestamp: data.timestamp,
                        }));
                    }
                break;

                case 'verify':
                    db.query('SELECT * FROM 25_riders WHERE id = ?', [data.id], (err, results) => {
                        if (err) {
                            console.error("Query error:", err);
                            ws.send(JSON.stringify({
                                type: 'verify_result',
                                status: 'error',
                                message: err.message
                            }));
                            return;
                        }

                        if (results.length > 0) {
                            // Rider found
                            ws.send(JSON.stringify({
                                type: 'verify_result',
                                status: 'success',
                                found: true,
                                rider: results[0]
                            }));
                            console.log('Rider found:', results[0].name);
                        } else {
                            // Rider not found
                            ws.send(JSON.stringify({
                                type: 'verify_result',
                                status: 'success',
                                found: false,
                                message: 'Rider not found'
                            }));
                            console.log('Rider not found for ID:', data.id);
                        }
                    });
                    break;

                case 'get_data':
                    db.query('SELECT * FROM 25_riders ORDER BY NAME', (err, results) => {
                        if (err) {
                            console.error("Query error:", err);
                            return;
                        }
                        ws.send(JSON.stringify({ type: 'riders_data', data: results }));
                    });
                    break;

                case 'get_riders_on_track':
                    sendOnTrack(ws);
                    break;

                case 'get_finished_riders':
                    sendFinishedRiders(ws, data.stage);
                    break;

                case 'get_all_results':
                    sendAllResults(ws);
                    break;

                case 'update_rider':
                    db.query('UPDATE 25_riders SET name=?, team=?, category=? WHERE id=?',
                        [data.name, data.team, data.category, data.id],
                        (err, result) => {
                            if (err) {
                                ws.send(JSON.stringify({ type: 'error', message: err.message }));
                            } else {
                                ws.send(JSON.stringify({ type: 'success', message: 'Rider updated' }));
                            }
                        });
                    break;

                case 'add_rider':
                    db.query('INSERT INTO 25_riders (id, rider_no, name, team, category) VALUES (?, ?, ?, ?, ?)',
                        [data.id, data.rider_no, data.name, data.team, data.category],
                        (err, result) => {
                            if (err) {
                                ws.send(JSON.stringify({ type: 'error', message: err.message }));
                            } else {
                                ws.send(JSON.stringify({ type: 'success', message: 'Rider added' }));
                            }
                        });
                    break;

                case 'set_stage': // update current_race_setting set stage, category
                    db.query('update current_race_setting set stage = ?, category = ? limit 1',
                        [data.stage, data.category],
                        (err, result) => {
                            if (err) {
                                ws.send(JSON.stringify({ type: 'error', message: err.message }));
                            } else {
                                console.log('Stage, category updated.');
                                wss.clients.forEach((client) => {
                                    if (client.readyState === WebSocket.OPEN) {
                                        client.send(JSON.stringify({
                                            type: 'set_stage_ok',
                                            message: 'Race settings updated. Stage: ' + data.stage + ' Category: ' + data.category,
                                            stage: data.stage,
                                            category: data.category
                                        }));
                                    }
                                });

                            }
                        });
                    break;

                case 'insert_start_time': // insert start time of the rider
                    db.query('insert into 25_times(rider_id, stage, start_time) values(?,?,?)',
                        [data.rider_id, data.stage, data.start_time],
                        (err, result) => {
                            if (err) {
                                // A duplicate means this rider/stage start is already
                                // stored — the write succeeded, possibly on an earlier
                                // attempt of this same event. Ack it so the device stops
                                // retrying; without this a replayed start would be
                                // retried forever against the unique key.
                                if (err.code === 'ER_DUP_ENTRY') ackEvent(ws, data.event_id);

                                // Reply only to the device that sent the start, and
                                // identify the rider/stage, so it can undo its
                                // optimistic clock on a duplicate without disturbing
                                // other devices' running timers.
                                if (ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({
                                        type: 'error',
                                        action: 'insert_start_time',
                                        rider_id: data.rider_id,
                                        stage: data.stage,
                                        message: err.message
                                    }));
                                }

                                console.log(err.message);
                            }
                            else {
                                // Row is committed — confirm to the sender before any
                                // of the follow-up broadcasts, so delivery is recorded
                                // even if a later query fails.
                                ackEvent(ws, data.event_id);

                                db.query('SELECT * FROM 25_riders WHERE id = ? limit 1', [data.rider_id], (err, results) => {
                                    if (err) {
                                        console.error("Query error:", err);
                                        return;
                                    }

                                    if (results.length > 0) {
                                        // send for live timing
                                        // Send to ALL clients (broadcast)
                                        wss.clients.forEach((client) => {
                                            if (client.readyState === WebSocket.OPEN) {
                                                client.send(JSON.stringify({
                                                    type: 'success',
                                                    message: 'Start time inserted: ' + data.rider_id + ' Time: ' + data.start_time + ' Stage: ' + data.stage,
                                                    rider_name: results[0].name,
                                                    rider_id: data.rider_id
                                                }));
                                            }
                                        });

                                        // Rider found
                                        db.query('insert into riders_on_track(rider_id,name,team,category,stage) values(?,?,?,?,?)',
                                            [results[0].id, results[0].name, results[0].team, results[0].category, data.stage],
                                            (err, result3) => {
                                                if (err) {
                                                    console.log(err.message);
                                                } else {
                                                    console.log('inserted to riders on track table');
                                                    broadcastOnTrack();
                                                }
                                            });
                                        console.log('Rider found, sent to clients for live timing.', results[0].name);
                                    } else {
                                        // Rider not found
                                        console.log('Rider not found for ID:', data.id);
                                    }
                                });
                            }
                        });
                    break;

                case 'insert_stop_time': // insert stop time of the rider
                    // The guard `? > start_time` is enforced in SQL so a stale or
                    // mis-assigned beam can never be stored. Writing the timestamp
                    // verbatim is what produced negative diff_time in results.
                    db.query('update 25_times set stop_time=? where (rider_id=? and stage=?) and stop_time is NULL and start_time is not NULL and ? > start_time limit 1',
                        [data.stop_time, data.rider_id, data.stage, data.stop_time],
                        (err, result) => {
                            if (err) {
                                // Send to ALL clients (broadcast)
                                wss.clients.forEach((client) => {
                                    if (client.readyState === WebSocket.OPEN) {
                                        client.send(JSON.stringify({
                                            type: 'error', message: err.message
                                        }));
                                    }
                                });
                                console.log(err.message);
                                return;   // no ack — let the device retry
                            }

                            if (result.affectedRows === 0) {
                                // Nothing applied. Find out why, so we ack only when
                                // retrying could never succeed.
                                db.query('select start_time, stop_time from 25_times where rider_id=? and stage=? limit 1',
                                    [data.rider_id, data.stage], (e2, r2) => {
                                        if (e2) { console.error(e2.message); return; }

                                        const reply = (message) => {
                                            if (ws.readyState === WebSocket.OPEN) {
                                                ws.send(JSON.stringify({
                                                    type: 'error', action: 'insert_stop_time',
                                                    rider_id: data.rider_id, stage: data.stage, message
                                                }));
                                            }
                                        };

                                        // No start on record yet. The start may still be in
                                        // flight from the other device, so do NOT ack — the
                                        // retry succeeds once it lands, and it stays visible
                                        // in the device's Unconfirmed list meanwhile.
                                        if (!r2.length) {
                                            reply('No start time yet for this rider/stage — will retry.');
                                            return;
                                        }
                                        // Already finished by an earlier attempt: idempotent.
                                        if (r2[0].stop_time !== null) {
                                            ackEvent(ws, data.event_id);
                                            return;
                                        }
                                        // Start exists and stop_time is still NULL, so this
                                        // timestamp failed the > start_time guard. Deterministic
                                        // — replaying identical data can never pass, so ack it
                                        // and surface the rejection to the operator.
                                        ackEvent(ws, data.event_id);
                                        reply('Rejected: finish time is not after the start time.');
                                        console.log('Rejected out-of-order stop for rider ' + data.rider_id + ' stage ' + data.stage);
                                    });
                                return;
                            }

                            // Applied cleanly — confirm delivery, then run the follow-ups.
                            ackEvent(ws, data.event_id);

                                db.query('delete from riders_on_track where rider_id=? and stage=? limit 1',
                                    [data.rider_id, data.stage], (err, results) => {
                                        if (err) {
                                            console.error("Query error:", err);
                                            return;
                                        } else {
                                            broadcastOnTrack();
                                            // 25_get_race_result is what computes diff_time
                                            // (UPDATE … SET diff_time = TIMEDIFF(…)). The finished
                                            // list must therefore be broadcast only AFTER the proc
                                            // returns — otherwise diff_time is still NULL and the
                                            // just-finished rider is filtered out of the finished
                                            // query, so clients never see the result.
                                            db.query('call 25_get_race_result(?,?)',
                                                [data.stage, data.category],
                                                (err, resultRace) => {
                                                    broadcastFinishedRiders(data.stage);
                                                    broadcastAllResults();
                                                    if (err) { console.error('race_result error:', err.message); return; }
                                                    // Send to ALL clients (broadcast)
                                                    wss.clients.forEach((client) => {
                                                        if (client.readyState === WebSocket.OPEN) {
                                                            client.send(JSON.stringify({
                                                                type: 'live_race_result',
                                                                message: 'Receiving live result. ',
                                                                data: resultRace
                                                            }));
                                                        }
                                                    });
                                                });
                                        }
                                    });
                        });
                    break;
            }
        } catch (e) {
            console.log('Not JSON, treating as plain text:', msg);
            // Backward compatibility
            if (msg === 'get_data') {
                db.query('SELECT * FROM 25_riders ORDER BY NAME', (err, results) => {
                    if (err) return;
                    ws.send(JSON.stringify({ type: 'riders_data', data: results }));
                });
            }

            if (msg === 'get_race_info') {
                db.query('select * from race_settings limit 1', (err, results) => {
                    if (err) return;
                    ws.send(JSON.stringify({ type: 'result_race_info', data: results[0] }));
                });
            }

            if (msg === 'get_race_settings') {
                db.query('SELECT * FROM current_race_setting LIMIT 1', (err, results) => {
                    if (err) {
                        console.error("Query error:", err);
                        ws.send(JSON.stringify({ type: 'error', message: err.message }));
                        return;
                    }

                    if (results.length > 0) {
                        // Result found, send it
                        ws.send(JSON.stringify({
                            type: 'result_race_setting',
                            data: results[0]
                        }));
                    } else {
                        // No result, insert/update then send
                        db.query('insert into current_race_setting(stage) value(1)', (err2, updateResult) => {
                            if (err2) {
                                console.error("Insert error:", err2);
                                ws.send(JSON.stringify({ type: 'error', message: err2.message }));
                                return;
                            }

                            // Send the default value
                            ws.send(JSON.stringify({
                                type: 'result_race_setting',
                                data: { stage: 1 }
                            }));
                        });
                    }
                });
            }


            if (msg === 'get_category_list') {
                db.query('SELECT category_name FROM 25_categories ', (err, results) => {
                    if (err) {
                        console.error("Query error:", err);
                        ws.send(JSON.stringify({ type: 'error', message: err.message }));
                        return;
                    }

                    if (results.length > 0) {
                        // Result found, send it
                        ws.send(JSON.stringify({
                            type: 'result_category_list',
                            data: results
                        }));
                    } else {
                        // No result
                        ws.send(JSON.stringify({
                            type: 'result_category_list',
                            data: 'no record found'
                        }));
                    }
                });
            }


        }
    });



    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

server.listen(process.env.PORT || 3000, () => {
    console.log("Server listening on http://localhost:3000");
});