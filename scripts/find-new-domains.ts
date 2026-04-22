import { readFile, writeFile } from "node:fs/promises";

type Config = {
  concurrency: number;
  dataPaths: string[];
  depth: number;
  format: OutputFormat;
  includeDiscovered: boolean;
  maxBytes: number;
  maxPages: number;
  outputPath?: string;
  progress: boolean;
  progressIntervalMs: number;
  seeds: string[];
  timeoutMs: number;
};

type CrawlItem = { depth: number; url: string };
type Candidate = { host: string; sources: Set<string>; urls: Set<string> };
type CandidateWriter = { close: () => void; write: (candidate: Candidate, url: URL, source: string) => Promise<void> };
type OutputFormat = "json" | "ndjson" | "tsv";

const args = Deno.args;
const encoder = new TextEncoder();
const dataPaths = ["data/nurijips-go.json", "data/nurijips-ac.json", "data/nurijips-etc.json"];
const targetHostPattern = /\.(?:go|ac)\.kr$/;
const blockedPathPattern = /\.(?:7z|avi|bmp|css|docx?|eot|gif|hwp|ico|jpe?g|js|mp4|pdf|png|pptx?|svg|ttf|webp|woff2?|xlsx?|zip)$/i;

const readArg = (name: string) => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const readArgs = (name: string) =>
  args.flatMap((arg, index) => arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1)] : arg === name ? [args[index + 1]] : []).filter(Boolean);
const readNumberArg = (name: string, fallback: number) => Number(readArg(name) ?? fallback);
const readFlag = (name: string) => args.includes(name);
const readFormat = () => readFlag("--json") ? "json" : readFlag("--ndjson") ? "ndjson" : readArg("--format") ?? "tsv";

function help() {
  console.log([
    "Usage: deno run --allow-read --allow-net --allow-write scripts/find-new-domains.ts [options]",
    "",
    "Options:",
    "  --data <path>          Existing nurijips JSON path. Can be passed multiple times.",
    "                         Defaults to data/nurijips-go.json, data/nurijips-ac.json, data/nurijips-etc.json",
    "  --seed <url>           Extra seed URL. Can be passed multiple times.",
    "  --depth <n>            Internal link crawl depth per host (default: 1)",
    "  --max-pages <n>        Max pages to fetch (default: 2000)",
    "  --concurrency <n>      Concurrent fetches (default: 8)",
    "  --timeout-ms <n>       Fetch timeout per page (default: 10000)",
    "  --max-bytes <n>        Max response bytes per page (default: 1048576)",
    "  --include-discovered   Also crawl newly discovered go.kr/ac.kr hosts",
    "  --format <format>      tsv, ndjson, or json (default: tsv)",
    "  --json                 Same as --format json",
    "  --ndjson               Same as --format ndjson",
    "  --output <path>        Stream TSV/NDJSON candidates to a file; JSON writes final report",
    "  --no-progress          Disable stderr progress logs",
    "  --progress-ms <n>      Progress log interval (default: 1000)",
  ].join("\n"));
}

function normalizeHost(host: string) {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return normalized.startsWith("www.") ? normalized.slice(4) : normalized;
}

function hostForComparison(url: URL) {
  return normalizeHost(url.hostname);
}

function hostFromExistingKey(key: string) {
  return hostForComparison(new URL(keyUrl(key)));
}

function urlFromInput(input: string, base?: string) {
  const value = input.trim().replaceAll("&amp;", "&").replace(/[)\].,;]+$/, "");
  if (!value || /^(?:mailto|tel|javascript|data):/i.test(value)) return;
  try {
    if (/^(?:[a-z0-9-]+\.)+(?:go|ac)\.kr$/i.test(value)) return new URL(`https://${value}/`);
    return new URL(value, base);
  } catch {
    return;
  }
}

function keyUrl(key: string) {
  return `https://${key}`;
}

function displayUrl(url: URL) {
  const path = `${url.pathname}${url.search}`;
  return `${hostForComparison(url)}${path === "/" ? "" : path}`;
}

function normalizePageUrl(url: URL) {
  url.hash = "";
  return url.href;
}

function tsv(value: string) {
  return value.replaceAll("\t", " ").replaceAll("\r", " ").replaceAll("\n", " ");
}

function isTargetHost(host: string) {
  return targetHostPattern.test(normalizeHost(host));
}

function isCrawlable(url: URL) {
  return /^https?:$/.test(url.protocol) && !blockedPathPattern.test(url.pathname);
}

function extractUrls(text: string, baseUrl: string) {
  const values = new Set<string>();
  const attrPattern = /\b(?:href|src|action|data-href|data-url)=["']([^"'<>]+)["']/gi;
  const absolutePattern = /\bhttps?:\/\/[^\s"'<>]+/gi;
  const hostPattern = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:go|ac)\.kr\b/gi;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(text))) values.add(match[1]!);
  while ((match = absolutePattern.exec(text))) values.add(match[0]!);
  while ((match = hostPattern.exec(text))) values.add(match[0]!);
  return [...values].map((value) => urlFromInput(value, baseUrl)).filter((url): url is URL => Boolean(url));
}

async function readText(response: Response, maxBytes: number) {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > maxBytes) return;
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchText(url: string, config: Config) {
  const parsed = new URL(url);
  const fallbackUrl = parsed.protocol === "https:" ? `http://${parsed.host}${parsed.pathname}${parsed.search}` : undefined;
  for (const fetchUrl of [url, fallbackUrl].filter(Boolean)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(fetchUrl!, {
        headers: { accept: "text/html,application/xhtml+xml,application/xml,text/plain,*/*;q=0.5", "user-agent": "awesome-nurijip-domain-crawler/0.1" },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType && !/(?:html|text|xml|json|javascript)/i.test(contentType)) continue;
      const text = await readText(response, config.maxBytes);
      if (text !== undefined) return { text, url: response.url };
    } catch {
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function addCandidate(candidates: Map<string, Candidate>, host: string, url: URL, source: string) {
  const normalizedHost = normalizeHost(host);
  const isNew = !candidates.has(normalizedHost);
  const candidate = candidates.get(normalizedHost) ?? { host: normalizedHost, sources: new Set(), urls: new Set() };
  candidate.urls.add(displayUrl(url));
  candidate.sources.add(source);
  candidates.set(normalizedHost, candidate);
  return isNew ? candidate : undefined;
}

async function openCandidateWriter(config: Config): Promise<CandidateWriter | undefined> {
  if (!config.outputPath || config.format === "json") return;
  const file = await Deno.open(config.outputPath, { create: true, truncate: true, write: true });
  if (config.format === "tsv") await file.write(encoder.encode("host\turl\tsource\n"));
  return {
    close: () => file.close(),
    write: (candidate, url, source) => {
      const line = config.format === "ndjson"
        ? `${JSON.stringify({ host: candidate.host, url: displayUrl(url), source })}\n`
        : `${tsv(candidate.host)}\t${tsv(displayUrl(url))}\t${tsv(source)}\n`;
      return file.write(encoder.encode(line)).then(() => undefined);
    },
  };
}

async function crawl(config: Config) {
  const datasets = await Promise.all(config.dataPaths.map(async (dataPath) => JSON.parse(await readFile(dataPath, "utf8")) as Record<string, unknown>));
  const keys = datasets.flatMap((data) => Object.keys(data).filter((key) => key !== "$schema"));
  const existingHosts = new Set(keys.map(hostFromExistingKey));
  const seedItems = config.seeds.map((seed) => ({ depth: 0, url: normalizePageUrl(new URL(seed)) }));
  const existingItems = keys.map((key) => ({ depth: 0, url: normalizePageUrl(new URL(keyUrl(key))) }));
  const queue: CrawlItem[] = [...seedItems, ...existingItems];
  const candidates = new Map<string, Candidate>();
  const writer = await openCandidateWriter(config);
  const queued = new Set(queue.map((item) => item.url));
  const visited = new Set<string>();
  const active = new Set<string>();
  const stats = { completed: 0, failed: 0, fetched: 0, startedAt: Date.now() };
  let cursor = 0;
  function logProgress(done = false) {
    if (!config.progress) return;
    const elapsed = ((Date.now() - stats.startedAt) / 1000).toFixed(1);
    const current = [...active].at(-1) ?? "-";
    const clipped = current.length > 90 ? `${current.slice(0, 87)}...` : current;
    const target = Math.min(config.maxPages, queued.size);
    console.error(`${done ? "done" : "progress"} elapsed=${elapsed}s completed=${stats.completed}/${target} fetched=${stats.fetched} failed=${stats.failed} queued=${queued.size} active=${active.size} candidates=${candidates.size} current=${clipped}`);
  }
  async function visit(item: CrawlItem) {
    const activeUrl = displayUrl(new URL(item.url));
    active.add(activeUrl);
    try {
      const page = await fetchText(item.url, config);
      if (!page) {
        stats.failed++;
        return;
      }
      stats.fetched++;
      const pageUrl = new URL(page.url);
      const pageHost = hostForComparison(pageUrl);
      for (const link of extractUrls(page.text, page.url)) {
        const linkHost = hostForComparison(link);
        if (isTargetHost(linkHost) && !existingHosts.has(linkHost)) {
          const candidate = addCandidate(candidates, linkHost, link, displayUrl(pageUrl));
          if (candidate) await writer?.write(candidate, link, displayUrl(pageUrl));
        }
        if (item.depth >= config.depth || !isCrawlable(link)) continue;
        const canFollow = linkHost === pageHost || (config.includeDiscovered && isTargetHost(linkHost));
        const normalizedUrl = normalizePageUrl(link);
        if (canFollow && !queued.has(normalizedUrl)) {
          queue.push({ depth: item.depth + 1, url: normalizedUrl });
          queued.add(normalizedUrl);
        }
      }
    } finally {
      stats.completed++;
      active.delete(activeUrl);
    }
  }
  const progressTimer = config.progress ? setInterval(logProgress, config.progressIntervalMs) : undefined;
  logProgress();
  try {
    while (cursor < queue.length && visited.size < config.maxPages) {
      const batch: Promise<void>[] = [];
      while (batch.length < config.concurrency && cursor < queue.length && visited.size < config.maxPages) {
        const item = queue[cursor++]!;
        if (visited.has(item.url)) continue;
        visited.add(item.url);
        batch.push(visit(item));
      }
      await Promise.all(batch);
    }
  } finally {
    if (progressTimer !== undefined) clearInterval(progressTimer);
    writer?.close();
    logProgress(true);
  }
  return {
    candidateCount: candidates.size,
    candidates: [...candidates.values()].map((candidate) => ({
      host: candidate.host,
      sources: [...candidate.sources].sort().slice(0, 5),
      urls: [...candidate.urls].sort().slice(0, 5),
    })).sort((a, b) => a.host.localeCompare(b.host)),
    completedCount: stats.completed,
    existingHostCount: existingHosts.size,
    failedCount: stats.failed,
    fetchedCount: stats.fetched,
    queuedCount: queued.size,
    visitedCount: visited.size,
  };
}

function renderText(report: Awaited<ReturnType<typeof crawl>>) {
  return [
    `visited\t${report.visitedCount}`,
    `completed\t${report.completedCount}`,
    `fetched\t${report.fetchedCount}`,
    `failed\t${report.failedCount}`,
    `queued\t${report.queuedCount}`,
    `existing_hosts\t${report.existingHostCount}`,
    `candidates\t${report.candidateCount}`,
    "",
    "host\turl\tsource",
    ...report.candidates.map((candidate) => `${candidate.host}\t${candidate.urls[0] ?? ""}\t${candidate.sources[0] ?? ""}`),
  ].join("\n");
}

async function main() {
  if (readFlag("--help")) {
    help();
    return;
  }
  const format = readFormat();
  if (!["json", "ndjson", "tsv"].includes(format)) throw new Error(`unsupported format: ${format}`);
  const config: Config = {
    concurrency: readNumberArg("--concurrency", 8),
    dataPaths: readArgs("--data").length ? readArgs("--data") : dataPaths,
    depth: readNumberArg("--depth", 1),
    format: format as OutputFormat,
    includeDiscovered: readFlag("--include-discovered"),
    maxBytes: readNumberArg("--max-bytes", 1024 * 1024),
    maxPages: readNumberArg("--max-pages", 2000),
    outputPath: readArg("--output"),
    progress: !readFlag("--no-progress"),
    progressIntervalMs: readNumberArg("--progress-ms", 1000),
    seeds: readArgs("--seed"),
    timeoutMs: readNumberArg("--timeout-ms", 10000),
  };
  const report = await crawl(config);
  if (config.outputPath) {
    if (config.format === "json") await writeFile(config.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`wrote ${config.outputPath}`);
  } else {
    console.log(config.format === "json" ? JSON.stringify(report, null, 2) : renderText(report));
  }
}

main().catch((error) => {
  console.error(error);
  Deno.exit(1);
});
