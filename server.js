// server.js
require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require('ws');
const mysql = require("mysql2");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname + '/public'));

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    connectionLimit: 10
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

// Current riders on track, with start_time recovered from the active
// 25_times row (stop_time IS NULL) — avoids needing a schema change.
function queryOnTrack(cb) {
    const sql =
        'SELECT rot.rider_id, rot.name, rot.team, rot.category, rot.stage, t.start_time ' +
        'FROM riders_on_track rot ' +
        'LEFT JOIN 25_times t ON t.rider_id = rot.rider_id AND t.stage = rot.stage AND t.stop_time IS NULL ' +
        'ORDER BY t.start_time';
    db.query(sql, (err, rows) => {
        if (err) { console.error('on_track query error:', err.message); cb([]); return; }
        cb(rows || []);
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

wss.on('connection', (ws) => {
    console.log('Client connected');

    ws.on('message', (message) => {
        const msg = message.toString();
        console.log('Received:', msg);

        try {
            const data = JSON.parse(msg);

            switch (data.action) {

                case 'ping': // ping pong
                    console.log('Send Pong to: '+data.from+' - '+data.timestamp);
                    wss.clients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'pong',
                                message: 'Ping received from: ' + data.from + ' Timestamp: ' + data.timestamp + ' Stage: ' + data.stage + ' Category: ' + data.category
                            }));
                        }
                    });
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

                                wss.clients.forEach((client) => {
                                    if (client.readyState === WebSocket.OPEN) {
                                        client.send(JSON.stringify({
                                            type: 'error', message: err.message
                                        }));
                                    }
                                });

                                console.log(err.message);
                            }
                            else {
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
                    db.query('update 25_times set stop_time=? where (rider_id=? and stage=?) and stop_time is NULL limit 1',
                        [data.stop_time, data.rider_id, data.stage],
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
                            }
                            else {
                                if (result.affectedRows === 0) {
                                    console.log("stop_time is not null. No rows were updated");
                                }

                                db.query('delete from riders_on_track where rider_id=? and stage=? limit 1',
                                    [data.rider_id, data.stage], (err, results) => {
                                        if (err) {
                                            console.error("Query error:", err);
                                            return;
                                        } else {
                                            broadcastOnTrack();
                                            db.query('call 25_get_race_result(?,?)',
                                                [data.stage, data.category],
                                                (err, resultRace) => {
                                                    if (err) return;
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



                            }
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