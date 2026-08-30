/* global module */
// 局域网设备（未运行 InnerNet）只读展示：解析本机 ARP 表，不主动扫描。
// ARP 表由操作系统在网络流量发生时被动学习，本模块只做读取与格式化。

const DEFAULT_TTL_MS = 10 * 60 * 1000;

// 常见厂商 OUI 前缀（仅做粗略推断，前缀不全会显示「未知厂商」）
const VENDORS = {
  'f01898': 'Apple', 'a483e7': 'Apple', 'acde48': 'Apple', 'd0e140': 'Apple', '7cd1c3': 'Apple',
  '001b63': 'Apple', '6c4a85': 'Apple',
  '647005': 'Xiaomi', '5087b8': 'Xiaomi', '64cc2e': 'Xiaomi', 'f4f5d8': 'Xiaomi', '286c07': 'Xiaomi',
  '18d6c7': 'Huawei', '346b31': 'Huawei', '50faab': 'Huawei', 'c8f0a0': 'Huawei', 'e8cd2d': 'Huawei',
  '001122': '', // 占位避免误判私有段
  '40b076': 'Honor', '54e1ad': 'Honor',
  '0021f3': 'OPPO', '6cb0ce': 'OPPO', 'c042cb': 'vivo', '8ceb95': 'vivo',
  '345a60': 'TP-Link', '50c2e8': 'TP-Link', 'a4a92b': 'TP-Link',
  '00259e': 'Synology', '001132': 'Synology',
  '08942b': 'ASUS', '04d4c4': 'ASUS',
  '305a3a': 'Microsoft', '7c1e52': 'Microsoft Surface',
  'dc4a3e': 'Intel', '001c42': 'Intel',
  '44d9e7': 'Raspberry Pi', 'b827eb': 'Raspberry Pi', 'e45f01': 'Raspberry Pi',
  '00e04c': 'Espressif', '246f28': 'Espressif(esp)', '5ccf7f': 'Espressif(esp)',
};

function normalizeMac(raw) {
  const hex = String(raw || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 12 || /^(0{12}|f{12})$/.test(hex)) return '';
  return hex.replace(/(..)(..)(..)(..)(..)(..)/, '$1:$2:$3:$4:$5:$6');
}

function vendorOf(mac) {
  const normalized = normalizeMac(mac);
  if (!normalized) return '';
  const prefix = normalized.replace(/:/g, '').slice(0, 6);
  // 组播 OUI（01:00:5e、33:33）与本地管理位（第二位为 2/6/a/e）不判厂商
  if (/^(01005e|3333)/.test(prefix)) return '';
  return VENDORS[prefix] || '';
}

function isMulticastMac(mac) {
  const normalized = normalizeMac(mac);
  if (!normalized) return true;
  const high = normalized.slice(0, 2);
  // 组播位：MAC 首字节最低位为 1（01、03、33、ab 中第二位是 1 的属组播/广播）
  const firstByte = parseInt(high, 16);
  return (firstByte & 1) === 1;
}

// macOS: `? (192.168.31.20) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]`
// Windows: `  192.168.31.1          aa-bb-cc-dd-ee-ff     动态`
function parseArpTable(text) {
  const now = new Date().toISOString();
  const entries = new Map();
  for (const line of String(text || '').split('\n')) {
    const macMatch = line.match(/\b([0-9a-fA-F]{1,2}[:-]){5}[0-9a-fA-F]{1,2}\b/);
    const ipMatch = line.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
    if (!macMatch || !ipMatch) continue;
    const ip = ipMatch[1];
    const mac = normalizeMac(macMatch[0]);
    if (!mac || isMulticastMac(mac)) continue;
    if (/^(127\.|224\.|239\.|255\.)/.test(ip)) continue;
    entries.set(ip, { ip, mac, vendor: vendorOf(mac), firstSeenAt: now });
  }
  return [...entries.values()];
}

function mergeLanDevices(stored, incoming, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  const merged = new Map();
  for (const device of stored || []) {
    merged.set(device.ip, device);
  }
  const nowIso = new Date(now).toISOString();
  for (const next of incoming || []) {
    const previous = merged.get(next.ip);
    merged.set(next.ip, {
      ...previous,
      ...next,
      firstSeenAt: previous?.firstSeenAt || next.firstSeenAt || nowIso,
      lastSeenAt: nowIso,
    });
  }
  const result = [];
  for (const [, device] of merged) {
    if (Date.parse(device.lastSeenAt || 0) < now - ttlMs) continue; // 过期即丢，ARP 表本身会老化
    result.push(device);
  }
  return result.sort((a, b) => a.ip.localeCompare(b.ip, 'en', { numeric: true }));
}

module.exports = { DEFAULT_TTL_MS, normalizeMac, vendorOf, isMulticastMac, parseArpTable, mergeLanDevices };
