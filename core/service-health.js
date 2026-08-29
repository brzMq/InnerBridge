/* global module */
const DEFAULT_PORTS = { discovery: 49321, chat: 7890, pairing: 7891, transfer: 49152 };
const RANGES = { discovery: 'udp', chat: 'tcp', pairing: 'tcp', transfer: 'tcp' };
function normalizePort(value, fallback) { const port = Number(value); return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback; }
function normalizeServicePorts(input = {}) { return Object.fromEntries(Object.entries(DEFAULT_PORTS).map(([name, fallback]) => [name, normalizePort(input[name], fallback)])); }
function describePort(name, port, occupied, expected = false) { return { name, port, protocol: RANGES[name] || 'tcp', occupied: Boolean(occupied), expected: Boolean(expected), state: occupied ? (expected ? 'healthy' : 'occupied') : 'available' }; }
module.exports = { DEFAULT_PORTS, RANGES, normalizePort, normalizeServicePorts, describePort };
