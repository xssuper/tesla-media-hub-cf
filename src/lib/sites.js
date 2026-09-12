import { fetchJson } from './fetcher.js';
import { parsePlayData } from './parsePlay.js';
import * as cfg from './store.js';
import { parseSource } from './sourceParser.js';

// ---------- 站点列表缓存 ----------
const siteCache = new Map(); // sourceId -> { ts, sites }
const CACHE_TTL = 10 * 60 * 1000;

async function getSites(source, { force = false } = {}) {
  const hit = siteCache.get(source.id);
  if (!force && hit && Date.now() - hit.ts < CACHE_TTL) return hit.sites;
  const sites = parseSource(source); // 同步，纯解析
  siteCache.set(source.id, { ts: Date.now(), sites });
  return sites;
}

function splitKey(key) {
  const i = key.indexOf('::');
  if (i < 0) return [key, 'main'];
  return [key.slice(0, i), key.slice(i + 2)];
}

async function resolveSite(sourceId, siteKeyInSource) {
  const source = await cfg.getSource(sourceId);
  if (!source) throw new Error('源不存在或已删除');
  const sites = await getSites(source);
  const full = `${sourceId}::${siteKeyInSource}`;
  const site = sites.find((s) => s.key === full);
  if (!site) throw new Error('站点不存在');
  return site;
}

// ---------- 通用数据整理 ----------
function normalizeVod(v) {
  return {
    vod_id: v.vod_id,
    vod_name: v.vod_name || v.name || '',
    vod_pic: v.vod_pic || v.pic || v.vod_pic_slide || '',
    vod_remarks: v.vod_remarks || v.remarks || '',
    vod_year: v.vod_year || '',
    vod_area: v.vod_area || '',
    vod_score: v.vod_score || '',
    type_name: v.type_name || v.type || '',
    vod_actor: v.vod_actor || '',
    vod_director: v.vod_director || '',
    vod_content: v.vod_content || '',
  };
}

function normalizeList(res) {
  return {
    page: Number(res.page || 1),
    pagecount: Number(res.pagecount || 1),
    total: res.total || 0,
    limit: res.limit || 0,
    list: (res.list || []).map(normalizeVod),
  };
}

function normalizeDetail(vod) {
  const base = normalizeVod(vod || {});
  const plays = parsePlayData(vod && vod.vod_play_from, vod && vod.vod_play_url);
  return { ...base, plays };
}

// ---------- AppleCMS 站点适配 ----------
function buildApiUrl(api, params) {
  const qs = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return api + (api.includes('?') ? '&' : '?') + qs;
}

async function fetchVodList(site, params) {
  for (const ac of ['detail', 'videolist']) {
    try {
      const res = await fetchJson(buildApiUrl(site.api, { ac, ...params }));
      if (res && Array.isArray(res.list) && res.list.length) return res;
    } catch (e) {
      /* 继续尝试下一种 ac */
    }
  }
  return { code: 1, page: 1, pagecount: 1, total: 0, list: [] };
}

function createAppleCmsSite(site) {
  return {
    async getHome() {
      let classes = [];
      try {
        const catRes = await fetchJson(buildApiUrl(site.api, { ac: 'list' }));
        if (catRes && Array.isArray(catRes.class)) {
          classes = catRes.class.map((c) => ({
            type_id: c.type_id,
            type_name: c.type_name,
          }));
        }
      } catch (e) {
        /* 部分站点不支持 ac=list */
      }

      let home = { page: 1, pagecount: 1, total: 0, limit: 0, list: [] };
      try {
        home = normalizeList(await fetchVodList(site, { pg: '1' }));
      } catch (e) {
        /* 忽略首页加载失败 */
      }
      // 带回 pagecount/total，前端「全部」视图据此显示分页
      return { classes, ...home };
    },

    async getCategory({ cat, page, filter }) {
      const params = { pg: String(page || 1) };
      if (cat) params.t = cat;
      if (filter && typeof filter === 'object') {
        for (const [k, v] of Object.entries(filter)) {
          if (v != null && v !== '') params[k] = v;
        }
      }
      return normalizeList(await fetchVodList(site, params));
    },

    async search({ wd, page }) {
      const params = { wd, pg: String(page || 1) };
      return normalizeList(await fetchVodList(site, params));
    },

    async getDetail({ id }) {
      const res = await fetchJson(buildApiUrl(site.api, { ac: 'detail', ids: id }));
      const vod = ((res && res.list) || [])[0] || {};
      return normalizeDetail(vod);
    },
  };
}

function createAdapter(site) {
  if (site.sourceType === 'iptv') throw new Error('IPTV 功能已禁用（本部署已移除）');
  return createAppleCmsSite(site);
}

export { getSites, resolveSite, splitKey, createAdapter };
