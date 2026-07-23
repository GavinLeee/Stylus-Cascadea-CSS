// ==UserScript==
// @name         Bilibili Video CDN Switcher - Smart Benchmark
// @name:zh-CN   Bilibili CDN 智能测速切换
// @namespace    local.codex.bilibili-cdn-switcher
// @version      0.4.0
// @description  后台分阶段测试真实媒体地址；采用更大采样块识别海外冷回源慢节点；可在首个播放请求短暂等待测速以便当次即切换；主线路明显偏慢或测不出时改用更快候选，并自动熔断失败节点。
// @author       Local optimized edition
// @license      MIT
// @run-at       document-start
// @match        https://www.bilibili.com/*
// @match        https://m.bilibili.com/*
// @match        https://search.bilibili.com/*
// @match        https://live.bilibili.com/blanc/*
// @match        https://music.bilibili.com/pc/music-center/*
// @icon         https://i0.hdslb.com/bfs/static/jinkela/long/images/512.png
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      bilivideo.com
// @connect      *.bilivideo.com
// @connect      akamaized.net
// @connect      *.akamaized.net
// ==/UserScript==

(function () {
    'use strict';

    const SCRIPT_NAME = 'BiliCDNSmartBenchmark';
    const STORAGE_DISABLED = 'disabled';
    // 兼容旧版脚本已经保存的自定义 CDN。
    const STORAGE_CUSTOM_CDN = 'CustomCDN';
    const STORAGE_BENCHMARK_CACHE = 'SmartBenchmarkCacheV2';

    const CODE_CUSTOM_CDN = '';
    const ALLOW_THIRD_PARTY_CDN = false;
    // 默认只测试播放接口给出的、签名完整的主地址和备用地址。
    // 直接替换为其他 CDN 时，os/upsig 等签名参数可能失效，因此不再内置强制候选。
    const KNOWN_CDNS = Object.freeze([]);

    const SETTINGS = Object.freeze({
        // 采样块调大：海外冷回源常见 0.5~5Mbps 的差距，小样本会被 TCP 慢启动/边缘突发掩盖，
        // 需要下载到足够数据才能反映“持续吞吐”。第一轮快测，第二轮仅复测主线路和最快候选。
        quickProbeBytes: 512 * 1024,
        confirmProbeBytes: 1536 * 1024,
        minProbeBytes: 128 * 1024,
        // 超时放宽：让 ~1.5MB 在偏慢节点上也能采到；真正很慢的节点会在此触发部分采样（记为偏低速度）或超时。
        probeTimeoutMs: 8000,
        probeConcurrency: 2,
        confirmRuns: 2,
        exactCacheTtlMs: 10 * 60 * 1000,
        failedProbeRetryMs: 30 * 1000,
        globalCacheTtlMs: 2 * 60 * 1000,
        maxExactCacheEntries: 48,
        // 以多次采样中的保守速度判定，避免被瞬时峰值误导。
        minGainRatio: 1.35,
        minGainMbps: 1.5,
        minBitrateHeadroom: 1.55,
        // 救急：候选比主线路“压倒性”更快（海外冷回源慢节点），即使达不到理想码率余量也切换——0.5→5Mbps 也值得切。
        rescueGainRatio: 2.0,
        rescueGainMbps: 1.0,
        // 主线路测不出/持续失败时，只要候选达到该绝对下限（Mbps）即改用候选。
        minUsableMbps: 1.2,
        // 首个播放请求最多等待多少毫秒做一次测速，让“当次播放”就切到快节点；设为 0 恢复旧行为（只影响下次加载）。
        firstLoadBenchmarkMaxMs: 3500,
        // 跨视频复用结果更保守。
        minGlobalGainRatio: 1.7,
        runtimeFailureWindowMs: 60 * 1000,
        runtimeFailureThreshold: 2,
        runtimeBlockMs: 3 * 60 * 1000
    });

    const page = unsafeWindow;
    const log = console.log.bind(console, `[${SCRIPT_NAME}]`);
    const warn = console.warn.bind(console, `[${SCRIPT_NAME}]`);
    const benchmarkJobs = new Map();

    function isBilibiliCdnHost(hostname) {
        const host = String(hostname || '').toLowerCase();
        return host === 'bilivideo.com' || host.endsWith('.bilivideo.com');
    }

    function isSupportedMediaHost(hostname) {
        const host = String(hostname || '').toLowerCase();
        return isBilibiliCdnHost(host) || host.endsWith('.akamaized.net');
    }

    function normalizeCdnHost(value) {
        if (value === null || value === undefined) return null;
        const raw = String(value).trim();
        if (!raw) return null;

        try {
            const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
            if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) return null;

            const hostname = parsed.hostname.toLowerCase();
            if (!ALLOW_THIRD_PARTY_CDN && !isBilibiliCdnHost(hostname)) {
                warn(`已拒绝非 bilivideo.com 的 CDN：${hostname}`);
                return null;
            }
            return hostname;
        } catch (error) {
            warn('CDN 地址格式无效：', value, error);
            return null;
        }
    }

    function getPreferredCustomHost() {
        const requested = CODE_CUSTOM_CDN || GM_getValue(STORAGE_CUSTOM_CDN, '');
        const normalized = normalizeCdnHost(requested);
        if (requested && !normalized) warn('自定义 CDN 无效，已忽略。');
        return normalized;
    }

    function emptyCache() {
        return { version: 2, exact: {}, global: {}, blocked: {} };
    }

    function loadCache() {
        const stored = GM_getValue(STORAGE_BENCHMARK_CACHE, null);
        if (!stored || typeof stored !== 'object' || stored.version !== 2) {
            return emptyCache();
        }
        if (!stored.exact || typeof stored.exact !== 'object') stored.exact = {};
        if (!stored.global || typeof stored.global !== 'object') stored.global = {};
        if (!stored.blocked || typeof stored.blocked !== 'object') stored.blocked = {};
        return stored;
    }

    function pruneAndSaveCache(cache) {
        const now = Date.now();
        for (const [key, value] of Object.entries(cache.exact)) {
            if (!value || value.expiresAt <= now) delete cache.exact[key];
        }
        for (const [key, value] of Object.entries(cache.global)) {
            if (!value || value.expiresAt <= now) delete cache.global[key];
        }
        for (const [host, value] of Object.entries(cache.blocked)) {
            if (
                !value ||
                (
                    value.blockedUntil <= now &&
                    now - Number(value.lastFailureAt || 0) > SETTINGS.runtimeFailureWindowMs
                )
            ) {
                delete cache.blocked[host];
            }
        }

        const exactEntries = Object.entries(cache.exact)
            .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
        for (const [key] of exactEntries.slice(SETTINGS.maxExactCacheEntries)) {
            delete cache.exact[key];
        }
        GM_setValue(STORAGE_BENCHMARK_CACHE, cache);
    }

    function clearBenchmarkCache() {
        GM_setValue(STORAGE_BENCHMARK_CACHE, emptyCache());
    }

    function hashString(value) {
        let hash = 2166136261;
        for (let index = 0; index < value.length; index += 1) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function getNetworkFingerprint() {
        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!connection) return 'unknown';
        return `${connection.effectiveType || 'unknown'}:${connection.saveData ? 1 : 0}`;
    }

    function getMediaIdentity(rawUrl, kind) {
        try {
            const url = new URL(rawUrl, page.location.href);
            if (!isSupportedMediaHost(url.hostname)) return null;
            const parentPath = url.pathname.replace(/\/[^/]*$/, '/');
            const fingerprint = getNetworkFingerprint();
            const originalHost = url.hostname.toLowerCase();
            return {
                originalHost,
                exactKey: `${kind}:${fingerprint}:${hashString(parentPath)}`,
                globalKey: `${kind}:${fingerprint}:${originalHost}`
            };
        } catch (error) {
            return null;
        }
    }

    function getUrlHost(rawUrl) {
        try {
            return new URL(rawUrl, page.location.href).hostname.toLowerCase();
        } catch (error) {
            return '';
        }
    }

    function getRequiredMbps(rawUrl) {
        try {
            const value = Number(new URL(rawUrl, page.location.href).searchParams.get('bw'));
            return Number.isFinite(value) && value > 0 ? value / 1000000 : 0;
        } catch (error) {
            return 0;
        }
    }

    function isHostBlocked(host) {
        const entry = loadCache().blocked[host];
        return Boolean(entry && entry.blockedUntil > Date.now());
    }

    function recordRuntimeFailure(rawUrl, reason) {
        const host = getUrlHost(rawUrl);
        if (!host) return;

        const cache = loadCache();
        const wasSelectedByScript = Object.values(cache.exact).some(decision =>
            decision &&
            decision.selectedHost === host &&
            decision.selectedHost !== decision.originalHost
        );
        if (!wasSelectedByScript) return;

        const now = Date.now();
        const previous = cache.blocked[host];
        const failures = previous && now - previous.lastFailureAt <= SETTINGS.runtimeFailureWindowMs
            ? previous.failures + 1
            : 1;
        const blockedUntil = failures >= SETTINGS.runtimeFailureThreshold
            ? now + SETTINGS.runtimeBlockMs
            : 0;
        cache.blocked[host] = { failures, lastFailureAt: now, blockedUntil, reason };

        if (blockedUntil) {
            for (const [key, decision] of Object.entries(cache.exact)) {
                if (decision && decision.selectedHost === host) delete cache.exact[key];
            }
            for (const [key, decision] of Object.entries(cache.global)) {
                if (decision && decision.selectedHost === host) delete cache.global[key];
            }
            warn(`节点 ${host} 连续失败，已熔断 ${Math.round(SETTINGS.runtimeBlockMs / 60000)} 分钟。`);
        }
        pruneAndSaveCache(cache);
    }

    function replaceMediaHost(rawUrl, targetHost) {
        if (typeof rawUrl !== 'string' || !rawUrl || !targetHost) return rawUrl;
        try {
            const url = new URL(rawUrl, page.location.href);
            if (!/^https?:$/.test(url.protocol) || !isBilibiliCdnHost(url.hostname)) {
                return rawUrl;
            }
            url.protocol = 'https:';
            url.hostname = targetHost;
            url.port = '';
            return url.href;
        } catch (error) {
            warn('无法转换媒体地址：', rawUrl, error);
            return rawUrl;
        }
    }

    function getProbeCandidates(descriptor) {
        const originalHost = getUrlHost(descriptor.originalUrl);
        const byHost = new Map();
        const realUrls = uniqueStrings([
            descriptor.originalUrl,
            ...readBackupUrls(descriptor.entry)
        ]);

        for (const rawUrl of realUrls) {
            const host = getUrlHost(rawUrl);
            if (!host || !isSupportedMediaHost(host) || byHost.has(host)) continue;
            byHost.set(host, { host, url: rawUrl, source: 'playinfo' });
        }

        // 只有存在 bilivideo 的真实签名地址时，才在 bilivideo 节点之间替换域名。
        const bilivideoSeed = realUrls.find(rawUrl => isBilibiliCdnHost(getUrlHost(rawUrl)));
        if (bilivideoSeed) {
            const requestedHosts = [getPreferredCustomHost(), ...KNOWN_CDNS].filter(Boolean);
            for (const host of requestedHosts) {
                if (byHost.has(host)) continue;
                byHost.set(host, {
                    host,
                    url: replaceMediaHost(bilivideoSeed, host),
                    source: 'derived'
                });
            }
        }

        return Array.from(byHost.values()).filter(candidate =>
            candidate.host === originalHost || !isHostBlocked(candidate.host)
        );
    }

    function probeUrl(candidate, targetBytes) {
        return new Promise(resolve => {
            const startedAt = performance.now();
            let firstByteAt = 0;
            let settled = false;
            let requestHandle = null;
            let lastLoaded = 0;

            const finish = result => {
                if (settled) return;
                settled = true;
                resolve(result);
            };

            const fail = (reason, status = 0, bytes = 0) => finish({
                ok: false,
                host: candidate.host,
                url: candidate.url,
                source: candidate.source,
                reason,
                status,
                bytes
            });

            const finishFromBytes = (bytes, status) => {
                const elapsedMs = Math.max(performance.now() - startedAt, 1);
                if ((status !== 200 && status !== 206) || bytes < SETTINGS.minProbeBytes) {
                    fail(status ? `HTTP ${status}` : '响应数据不足', status, bytes);
                    return;
                }
                finish({
                    ok: true,
                    host: candidate.host,
                    url: candidate.url,
                    source: candidate.source,
                    mbps: (bytes * 8) / (elapsedMs / 1000) / 1000000,
                    elapsedMs,
                    ttfbMs: firstByteAt ? Math.max(firstByteAt - startedAt, 0) : elapsedMs,
                    bytes,
                    status
                });
            };

            if (typeof GM_xmlhttpRequest !== 'function') {
                fail('GM_xmlhttpRequest 不可用');
                return;
            }

            requestHandle = GM_xmlhttpRequest({
                method: 'GET',
                url: candidate.url,
                headers: { Range: `bytes=0-${targetBytes - 1}` },
                responseType: 'arraybuffer',
                timeout: SETTINGS.probeTimeoutMs,
                onprogress(event) {
                    const bytes = Number(event.loaded) || 0;
                    if (bytes > lastLoaded) lastLoaded = bytes;
                    if (bytes > 0 && !firstByteAt) firstByteAt = performance.now();
                    if (bytes < targetBytes) return;
                    finishFromBytes(targetBytes, Number(event.status) || 206);
                    try {
                        requestHandle.abort();
                    } catch (error) {
                        // 请求已经结算。
                    }
                },
                onload(response) {
                    const bytes = response.response && typeof response.response.byteLength === 'number'
                        ? Math.min(response.response.byteLength, targetBytes)
                        : 0;
                    if (bytes > 0 && !firstByteAt) firstByteAt = performance.now();
                    finishFromBytes(bytes, Number(response.status));
                },
                ontimeout() {
                    // 慢节点也要给出真实（偏低）速度供比较；否则会被当作“无数据”而错失切换判断。
                    if (lastLoaded >= SETTINGS.minProbeBytes) finishFromBytes(lastLoaded, 206);
                    else fail('超时');
                },
                onerror(response) { fail('网络错误', Number(response && response.status)); },
                onabort() {
                    if (!settled) fail('请求被中止');
                }
            });
        });
    }

    async function runWithConcurrency(items, limit, worker) {
        const results = new Array(items.length);
        let cursor = 0;
        const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (cursor < items.length) {
                const index = cursor;
                cursor += 1;
                results[index] = await worker(items[index], index);
            }
        });
        await Promise.all(runners);
        return results;
    }

    function median(values) {
        if (!values.length) return 0;
        const sorted = values.slice().sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) / 2;
    }

    function summarizeHost(host, samples) {
        const successful = samples.filter(sample => sample.ok && sample.host === host);
        if (!successful.length) return null;
        const speeds = successful.map(sample => sample.mbps);
        return {
            host,
            count: successful.length,
            conservativeMbps: Math.min(...speeds),
            medianMbps: median(speeds),
            maxTtfbMs: Math.max(...successful.map(sample => sample.ttfbMs))
        };
    }

    async function benchmarkMedia(descriptor) {
        const kind = descriptor.kind;
        const originalUrl = descriptor.originalUrl;
        const identity = getMediaIdentity(originalUrl, kind);
        if (!identity) return null;

        const candidates = getProbeCandidates(descriptor);
        const quickResults = await runWithConcurrency(
            candidates,
            SETTINGS.probeConcurrency,
            candidate => probeUrl(candidate, SETTINGS.quickProbeBytes)
        );
        const quickSuccesses = quickResults.filter(result => result.ok);
        const officialQuick = quickSuccesses.find(result => result.host === identity.originalHost) || null;
        const bestAlternativeQuick = quickSuccesses
            .filter(result => result.host !== identity.originalHost)
            .sort((a, b) => b.mbps - a.mbps)[0] || null;

        // 只要存在可用候选就进入复测（同时复测主线路）——这样即便主线路首轮很慢/失败，
        // 候选也能拿到 >=2 次采样，从而触发“主线路测不出即改用候选”的判断。
        const confirmCandidates = bestAlternativeQuick
            ? candidates.filter(candidate =>
                candidate.host === identity.originalHost || candidate.host === bestAlternativeQuick.host
            )
            : [];
        const confirmTasks = [];
        for (const candidate of confirmCandidates) {
            for (let run = 0; run < SETTINGS.confirmRuns; run += 1) {
                confirmTasks.push(candidate);
            }
        }
        const confirmResults = await runWithConcurrency(
            confirmTasks,
            SETTINGS.probeConcurrency,
            candidate => probeUrl(candidate, SETTINGS.confirmProbeBytes)
        );
        const allResults = [...quickResults, ...confirmResults];
        const official = summarizeHost(identity.originalHost, allResults);
        const alternative = bestAlternativeQuick
            ? summarizeHost(bestAlternativeQuick.host, allResults)
            : null;

        let selectedHost = identity.originalHost;
        let selected = official;
        let gainRatio = 0;
        const requiredMbps = getRequiredMbps(originalUrl);
        if (alternative && alternative.count >= 2 && !isHostBlocked(alternative.host)) {
            const altSpeed = alternative.conservativeMbps;
            const officialUsable = Boolean(official && official.count >= 2);
            const offSpeed = officialUsable ? official.conservativeMbps : 0;
            gainRatio = altSpeed / Math.max(offSpeed, 0.01);
            const gain = altSpeed - offSpeed;
            const hasHeadroom = !requiredMbps ||
                altSpeed >= requiredMbps * SETTINGS.minBitrateHeadroom;
            // ① 常规：主线路可测，候选更快且能满足码率余量。
            const normalSwitch = officialUsable &&
                gainRatio >= SETTINGS.minGainRatio &&
                gain >= SETTINGS.minGainMbps &&
                hasHeadroom;
            // ② 救急：候选压倒性更快（海外冷回源慢节点），即使达不到理想余量也值得切。
            const rescueSwitch = officialUsable &&
                gainRatio >= SETTINGS.rescueGainRatio &&
                gain >= SETTINGS.rescueGainMbps;
            // ③ 主线路测不出/持续失败，但候选达到可用下限时改用候选。
            const mainUnusableSwitch = !officialUsable && altSpeed >= SETTINGS.minUsableMbps;
            if (normalSwitch || rescueSwitch || mainUnusableSwitch) {
                selectedHost = alternative.host;
                selected = alternative;
            }
        }

        const successfulHosts = Array.from(new Set(
            allResults.filter(result => result.ok).map(result => result.host)
        ));
        const now = Date.now();
        const decision = {
            selectedHost,
            originalHost: identity.originalHost,
            officialMbps: official ? official.conservativeMbps : 0,
            selectedMbps: selected ? selected.conservativeMbps : 0,
            gainRatio,
            requiredMbps,
            successfulHosts,
            measured: Boolean(official && alternative),
            updatedAt: now,
            expiresAt: now + (official ? SETTINGS.exactCacheTtlMs : SETTINGS.failedProbeRetryMs)
        };

        const cache = loadCache();
        cache.exact[identity.exactKey] = decision;
        if (
            selectedHost !== identity.originalHost &&
            official &&
            alternative &&
            gainRatio >= SETTINGS.minGlobalGainRatio
        ) {
            cache.global[identity.globalKey] = {
                ...decision,
                expiresAt: now + SETTINGS.globalCacheTtlMs
            };
        } else {
            delete cache.global[identity.globalKey];
        }
        pruneAndSaveCache(cache);

        const reports = Array.from(new Set(allResults.map(result => result.host))).map(host => {
            const summary = summarizeHost(host, allResults);
            if (summary) {
                return `${host}=${summary.conservativeMbps.toFixed(1)}Mbps` +
                    `(${summary.count}次, TTFB≤${Math.round(summary.maxTtfbMs)}ms)`;
            }
            const failure = allResults.find(result => !result.ok && result.host === host);
            return `${host}=失败(${failure ? failure.reason : '无响应'})`;
        });
        log(`${kind} 测速：${reports.join(', ') || '无候选'}；${
            selectedHost === identity.originalHost ? '保持主线路' : `切换 ${selectedHost}`
        }`);
        return decision;
    }

    function getCachedDecision(originalUrl, kind) {
        const identity = getMediaIdentity(originalUrl, kind);
        if (!identity) return null;

        const now = Date.now();
        const cache = loadCache();
        const exact = cache.exact[identity.exactKey];
        if (exact && exact.expiresAt > now && exact.originalHost === identity.originalHost) {
            return exact;
        }

        const global = cache.global[identity.globalKey];
        if (
            global &&
            global.expiresAt > now &&
            global.originalHost === identity.originalHost &&
            global.gainRatio >= SETTINGS.minGlobalGainRatio
        ) {
            return global;
        }
        return null;
    }

    function ensureBenchmark(descriptor) {
        const { originalUrl, kind } = descriptor;
        const identity = getMediaIdentity(originalUrl, kind);
        if (!identity) return Promise.resolve(null);

        const activeDecision = getCachedDecision(originalUrl, kind);
        if (activeDecision && activeDecision.expiresAt > Date.now()) {
            return Promise.resolve(activeDecision);
        }

        const jobKey = `${identity.exactKey}:${identity.originalHost}`;
        if (benchmarkJobs.has(jobKey)) return benchmarkJobs.get(jobKey);

        const job = benchmarkMedia(descriptor)
            .catch(error => {
                warn(`${kind} 测速失败，继续使用官方线路：`, error);
                return null;
            })
            .finally(() => benchmarkJobs.delete(jobKey));
        benchmarkJobs.set(jobKey, job);
        return job;
    }

    function uniqueStrings(values) {
        return Array.from(new Set(values.filter(value =>
            typeof value === 'string' && value.length > 0
        )));
    }

    function readBackupUrls(entry) {
        const backups = [];
        for (const key of ['backup_url', 'backupUrl']) {
            const value = entry && entry[key];
            if (Array.isArray(value)) backups.push(...value);
            else if (typeof value === 'string') backups.push(value);
        }
        return uniqueStrings(backups);
    }

    function writeBackupUrls(entry, originalUrl, selectedUrl, decision) {
        const measuredAlternatives = decision && Array.isArray(decision.successfulHosts)
            ? decision.successfulHosts
                .map(host => replaceMediaHost(originalUrl, host))
                .filter(url => url !== selectedUrl)
            : [];
        const backups = uniqueStrings([
            originalUrl,
            ...readBackupUrls(entry),
            ...measuredAlternatives
        ]);
        if (!backups.length) return;
        entry.backup_url = backups.slice();
        entry.backupUrl = backups.slice();
    }

    function collectMediaEntries(playInfo) {
        const descriptors = [];
        const visitedContainers = new WeakSet();
        const visitedEntries = new WeakSet();

        function addDashEntries(list, kind) {
            if (!Array.isArray(list)) return;
            for (const entry of list) {
                if (!entry || typeof entry !== 'object' || visitedEntries.has(entry)) continue;
                visitedEntries.add(entry);
                const originalUrl =
                    (typeof entry.base_url === 'string' && entry.base_url) ||
                    (typeof entry.baseUrl === 'string' && entry.baseUrl) ||
                    null;
                if (originalUrl) descriptors.push({ entry, originalUrl, kind, type: 'dash' });
            }
        }

        function addDurlEntries(list) {
            if (!Array.isArray(list)) return;
            for (const entry of list) {
                if (!entry || typeof entry !== 'object' || visitedEntries.has(entry)) continue;
                visitedEntries.add(entry);
                if (typeof entry.url === 'string' && entry.url) {
                    descriptors.push({ entry, originalUrl: entry.url, kind: 'video', type: 'durl' });
                }
            }
        }

        function visit(container) {
            if (!container || typeof container !== 'object' || visitedContainers.has(container)) return;
            visitedContainers.add(container);

            const dash = container.dash;
            if (dash && typeof dash === 'object') {
                addDashEntries(dash.video, 'video');
                addDashEntries(dash.audio, 'audio');
                addDashEntries(dash.dolby && dash.dolby.audio, 'audio');
                addDashEntries(dash.flac && dash.flac.audio, 'audio');
            }
            addDurlEntries(container.durl);
            if (Array.isArray(container.durls)) {
                for (const group of container.durls) addDurlEntries(group && group.durl);
            }
            if (container.video_info && typeof container.video_info === 'object') {
                visit(container.video_info);
            }
        }

        for (const candidate of [playInfo, playInfo && playInfo.data, playInfo && playInfo.result]) {
            visit(candidate);
        }
        return descriptors;
    }

    function applyCachedDecisions(descriptors) {
        for (const descriptor of descriptors) {
            const decision = getCachedDecision(descriptor.originalUrl, descriptor.kind);
            if (!decision || !decision.selectedHost) continue;

            const originalHost = getUrlHost(descriptor.originalUrl);
            if (decision.selectedHost === originalHost) continue;

            const matchingRealUrl = uniqueStrings([
                descriptor.originalUrl,
                ...readBackupUrls(descriptor.entry)
            ]).find(rawUrl => getUrlHost(rawUrl) === decision.selectedHost);
            const replacement = matchingRealUrl || (
                isBilibiliCdnHost(originalHost) && isBilibiliCdnHost(decision.selectedHost)
                    ? replaceMediaHost(descriptor.originalUrl, decision.selectedHost)
                    : descriptor.originalUrl
            );
            if (replacement === descriptor.originalUrl) continue;
            writeBackupUrls(descriptor.entry, descriptor.originalUrl, replacement, decision);

            if (descriptor.type === 'dash') {
                descriptor.entry.base_url = replacement;
                descriptor.entry.baseUrl = replacement;
            } else {
                descriptor.entry.url = replacement;
            }
        }
    }

    function getRepresentatives(descriptors) {
        const representatives = new Map();
        for (const descriptor of descriptors) {
            if (!representatives.has(descriptor.kind)) {
                representatives.set(descriptor.kind, descriptor);
            }
        }
        return Array.from(representatives.values());
    }

    function isValidPlayInfo(playInfo) {
        if (!playInfo || typeof playInfo !== 'object') return false;
        if ('code' in playInfo && playInfo.code !== 0) {
            warn('播放地址接口返回错误：', playInfo.code, playInfo.message || '');
            return false;
        }
        return true;
    }

    function transformPlayInfo(playInfo) {
        if (!isValidPlayInfo(playInfo)) return playInfo;
        const descriptors = collectMediaEntries(playInfo);
        applyCachedDecisions(descriptors);
        const videoDescriptor = getRepresentatives(descriptors)
            .find(descriptor => descriptor.kind === 'video');
        if (videoDescriptor) void ensureBenchmark(videoDescriptor);
        return playInfo;
    }

    async function transformPlayInfoAsync(playInfo) {
        if (!isValidPlayInfo(playInfo)) return playInfo;
        const descriptors = collectMediaEntries(playInfo);
        applyCachedDecisions(descriptors);
        const videoDescriptor = getRepresentatives(descriptors)
            .find(descriptor => descriptor.kind === 'video');
        if (videoDescriptor) {
            const alreadyDecided = Boolean(getCachedDecision(videoDescriptor.originalUrl, videoDescriptor.kind));
            if (!alreadyDecided && SETTINGS.firstLoadBenchmarkMaxMs > 0) {
                // 首个播放请求：最多等待 firstLoadBenchmarkMaxMs 做一次测速，让“当次播放”就落到快节点；
                // 超时则先放行（后台继续测速，结果供后续加载使用）。仅作用于可 await 的 fetch 路径。
                await Promise.race([
                    ensureBenchmark(videoDescriptor).catch(() => null),
                    new Promise(resolve => { setTimeout(resolve, SETTINGS.firstLoadBenchmarkMaxMs); })
                ]);
                // 用刚得到的决策再改写一次媒体地址。
                applyCachedDecisions(descriptors);
            } else {
                void ensureBenchmark(videoDescriptor);
            }
        }
        return playInfo;
    }

    function getUrlString(input) {
        if (typeof input === 'string') return input;
        if (input instanceof URL) return input.href;
        if (input && typeof input.url === 'string') return input.url;
        return String(input || '');
    }

    function isPlayUrlApi(input) {
        const raw = getUrlString(input);
        if (!raw) return false;
        try {
            const url = new URL(raw, page.location.href);
            if (url.hostname !== 'api.bilibili.com') return false;
            return (
                /^\/x\/player\/(?:wbi\/)?playurl\/?$/.test(url.pathname) ||
                /^\/pgc\/player\/web(?:\/v2)?\/playurl\/?$/.test(url.pathname) ||
                /^\/pugv\/player\/web\/playurl\/?$/.test(url.pathname)
            );
        } catch (error) {
            return false;
        }
    }

    function isMediaRequestUrl(input) {
        const raw = getUrlString(input);
        if (!raw) return false;
        try {
            const url = new URL(raw, page.location.href);
            return isSupportedMediaHost(url.hostname) &&
                /\.(?:m4s|mp4|flv)(?:$|\?)/i.test(url.href);
        } catch (error) {
            return false;
        }
    }

    function transformResponseText(text) {
        if (typeof text !== 'string' || !text) return text;
        try {
            const payload = JSON.parse(text);
            transformPlayInfo(payload);
            return JSON.stringify(payload);
        } catch (error) {
            warn('播放地址响应无法解析，已原样返回：', error);
            return text;
        }
    }

    async function transformResponseTextAsync(text) {
        if (typeof text !== 'string' || !text) return text;
        try {
            const payload = JSON.parse(text);
            await transformPlayInfoAsync(payload);
            return JSON.stringify(payload);
        } catch (error) {
            warn('播放地址响应无法解析，已原样返回：', error);
            return text;
        }
    }

    function cloneJsonValue(value) {
        try {
            if (typeof page.structuredClone === 'function') return page.structuredClone(value);
        } catch (error) {
            // 继续使用 JSON 兼容回退。
        }
        return JSON.parse(JSON.stringify(value));
    }

    function transformResponseObject(value) {
        if (!value || typeof value !== 'object') return value;
        try {
            const copy = cloneJsonValue(value);
            return transformPlayInfo(copy);
        } catch (error) {
            warn('播放地址对象转换失败，已原样返回：', error);
            return value;
        }
    }

    function wrapFetchResponse(response, requestUrl) {
        if (!response || !isPlayUrlApi(requestUrl)) return response;
        return new Proxy(response, {
            get(target, property) {
                if (property === 'text') {
                    return () => target.text().then(transformResponseTextAsync);
                }
                if (property === 'json') {
                    return () => target.text()
                        .then(text => JSON.parse(text))
                        .then(transformPlayInfoAsync);
                }
                if (property === 'clone') {
                    return () => wrapFetchResponse(target.clone(), requestUrl);
                }
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });
    }

    function installFetchInterceptor() {
        if (typeof page.fetch !== 'function') return;
        const originalFetch = page.fetch.bind(page);
        const patchedFetch = function (input, init) {
            const requestUrl = getUrlString(input);
            const result = originalFetch(input, init);
            if (!isPlayUrlApi(requestUrl)) return result;
            return result.then(response => wrapFetchResponse(response, requestUrl));
        };
        try {
            Object.defineProperty(patchedFetch, 'name', { value: 'fetch' });
            Object.defineProperty(patchedFetch, 'length', { value: 2 });
        } catch (error) {
            // 函数元数据伪装失败不影响功能。
        }
        page.fetch = patchedFetch;
    }

    function installXhrInterceptor() {
        const OriginalXMLHttpRequest = page.XMLHttpRequest;
        if (typeof OriginalXMLHttpRequest !== 'function') return;
        const transformedCache = new WeakMap();

        function transformXhrValue(xhr, rawValue) {
            if (xhr.readyState !== 4 || !isPlayUrlApi(xhr.responseURL)) return rawValue;
            const cached = transformedCache.get(xhr);
            if (cached && cached.rawValue === rawValue) return cached.transformedValue;

            let transformedValue = rawValue;
            if (typeof rawValue === 'string') {
                transformedValue = transformResponseText(rawValue);
            } else if (rawValue && typeof rawValue === 'object' && xhr.responseType === 'json') {
                transformedValue = transformResponseObject(rawValue);
            }
            transformedCache.set(xhr, { rawValue, transformedValue });
            return transformedValue;
        }

        class PatchedXMLHttpRequest extends OriginalXMLHttpRequest {
            open(method, url, ...rest) {
                const mediaUrl = getUrlString(url);
                if (isMediaRequestUrl(mediaUrl)) {
                    this.addEventListener('error', () => recordRuntimeFailure(mediaUrl, 'XHR error'), { once: true });
                    this.addEventListener('timeout', () => recordRuntimeFailure(mediaUrl, 'XHR timeout'), { once: true });
                }
                return super.open(method, url, ...rest);
            }
            get responseText() {
                return transformXhrValue(this, super.responseText);
            }
            get response() {
                return transformXhrValue(this, super.response);
            }
        }
        page.XMLHttpRequest = PatchedXMLHttpRequest;
    }

    function safelyTransform(value, transformer, label) {
        try {
            if (value !== undefined && value !== null) transformer(value);
        } catch (error) {
            warn(`${label} 转换失败：`, error);
        }
        return value;
    }

    function installTransformingProperty(propertyName, transformer) {
        try {
            const descriptor = Object.getOwnPropertyDescriptor(page, propertyName);
            if (descriptor && descriptor.configurable === false) {
                safelyTransform(page[propertyName], transformer, propertyName);
                return false;
            }

            const originalGetter = descriptor && descriptor.get;
            const originalSetter = descriptor && descriptor.set;
            let internalValue = descriptor && 'value' in descriptor ? descriptor.value : undefined;
            if (originalGetter) {
                try {
                    internalValue = originalGetter.call(page);
                } catch (error) {
                    warn(`读取原始 ${propertyName} 失败：`, error);
                }
            }
            safelyTransform(internalValue, transformer, propertyName);

            Object.defineProperty(page, propertyName, {
                configurable: true,
                enumerable: descriptor ? descriptor.enumerable : true,
                get() { return originalGetter ? originalGetter.call(this) : internalValue; },
                set(value) {
                    safelyTransform(value, transformer, propertyName);
                    if (originalSetter) originalSetter.call(this, value);
                    else internalValue = value;
                }
            });
            return true;
        } catch (error) {
            warn(`无法安装 ${propertyName} 监听：`, error);
            return false;
        }
    }

    function transformMobileOptions(options) {
        if (!options || typeof options !== 'object' || typeof options.readyVideoUrl !== 'string') return;
        const originalUrl = options.readyVideoUrl;
        const decision = getCachedDecision(originalUrl, 'video');
        if (decision && decision.selectedHost) {
            options.readyVideoUrl = replaceMediaHost(originalUrl, decision.selectedHost);
        }
        void ensureBenchmark({
            entry: options,
            originalUrl,
            kind: 'video',
            type: 'durl'
        });
    }

    function registerMenuCommands() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        const disabled = Boolean(GM_getValue(STORAGE_DISABLED, false));

        GM_registerMenuCommand(
            `${disabled ? '❌' : '✅'} 智能 CDN：${disabled ? '已禁用' : '已启用'}`,
            () => {
                GM_setValue(STORAGE_DISABLED, !disabled);
                page.location.reload();
            }
        );

        GM_registerMenuCommand('🌐 设置优先候选 CDN', () => {
            const current = String(GM_getValue(STORAGE_CUSTOM_CDN, '') || '');
            const input = page.prompt(
                [
                    '输入一个 bilivideo.com CDN 域名，将优先纳入测速。',
                    '它不会被无条件强制使用；只有实测明显更快才会切换。',
                    '留空表示清除优先候选。'
                ].join('\n'),
                current
            );
            if (input === null) return;
            const trimmed = input.trim();
            if (!trimmed) {
                GM_setValue(STORAGE_CUSTOM_CDN, '');
                clearBenchmarkCache();
                page.location.reload();
                return;
            }
            const normalized = normalizeCdnHost(trimmed);
            if (!normalized) {
                page.alert('CDN 地址无效。默认仅允许 bilivideo.com 域名。');
                return;
            }
            GM_setValue(STORAGE_CUSTOM_CDN, normalized);
            clearBenchmarkCache();
            page.location.reload();
        });

        GM_registerMenuCommand('🧹 清除测速结果并重新测试', () => {
            clearBenchmarkCache();
            page.location.reload();
        });

        GM_registerMenuCommand('📊 查看最近测速结果', () => {
            const cache = loadCache();
            const lines = Object.values(cache.exact)
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
                .slice(0, 8)
                .map(decision => [
                    `${decision.originalHost} → ${decision.selectedHost}`,
                    `主线路 ${Number(decision.officialMbps || 0).toFixed(1)} Mbps`,
                    `采用 ${Number(decision.selectedMbps || 0).toFixed(1)} Mbps`,
                    decision.measured ? '已完成双线路复测' : '未取得完整对照结果'
                ].join('；'));
            const blocked = Object.entries(cache.blocked)
                .filter(([, value]) => value && value.blockedUntil > Date.now())
                .map(([host, value]) => `${host}（剩余 ${Math.ceil((value.blockedUntil - Date.now()) / 60000)} 分钟）`);
            page.alert([
                '最近测速：',
                ...(lines.length ? lines : ['暂无结果']),
                '',
                '已熔断节点：',
                ...(blocked.length ? blocked : ['无'])
            ].join('\n'));
        });

        GM_registerMenuCommand('↩️ 恢复完全自动模式', () => {
            GM_setValue(STORAGE_CUSTOM_CDN, '');
            clearBenchmarkCache();
            page.location.reload();
        });
    }

    registerMenuCommands();
    if (Boolean(GM_getValue(STORAGE_DISABLED, false))) {
        log('脚本已禁用；可从 Tampermonkey 菜单重新启用。');
        return;
    }

    installFetchInterceptor();
    installXhrInterceptor();
    if (page.location.hostname === 'm.bilibili.com') {
        installTransformingProperty('options', transformMobileOptions);
    } else {
        installTransformingProperty('__playinfo__', transformPlayInfo);
    }
    log('v0.4.0 已启用：更大采样块识别慢节点；首个播放请求最多等待测速以便当次切换；主线路明显偏慢/测不出时改用更快候选。');
})();
