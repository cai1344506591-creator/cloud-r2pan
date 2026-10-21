import type { Env } from "./types";

/* ═══════════ Settings 内存缓存 ═══════════
 * 问题：getSettings() 每次都 SELECT * FROM settings 全表查询，
 *       下载 / 分享 / OAuth / Turnstile 等高频路径都要调，
 *       白白多一次 D1 往返。
 *
 * 策略：isolate 内缓存 + 5 秒 TTL + updateSettings 主动失效。
 *       5 秒足够短（管理员改完最多 5 秒全量生效），
 *       又足够把同一波并发请求合并掉，D1 压力骤降。
 *       跨 isolate 不同步，靠 TTL 自愈（可接受，因为管理员不会每秒改设置）。
 * ⚠️ 不要随意调大 TTL：settings 含 adminIps（IP 白名单）、2FA 等安全关键项，
 *    跨 isolate 的失效延迟会同步放大（= 放宽 fail-open 窗口）。
 */
const SETTINGS_CACHE_TTL_MS = 5_000; // 5 秒
let _cachedSettings: Settings | null = null;
let _cachedAt = 0;

/** 主动失效缓存 —— updateSettings 后调用 */
export function invalidateSettingsCache(): void {
  _cachedSettings = null;
  _cachedAt = 0;
}

/** 可调参数（均可在管理后台修改） */
export interface Settings {
  siteTitle: string;
  /** 月度流量限额（字节），0 = 不限 */
  trafficLimitBytes: number;
  /** 本月已用流量（字节） */
  trafficUsedBytes: number;
  /** 当前统计月份 YYYY-MM */
  trafficMonth: string;
  /** 单 IP 对同一分享的最大下载次数，0 = 不限 */
  maxDownloadsPerIp: number;
  /** 重复下载统计窗口（小时），0 = 永久 */
  countWindowHours: number;
  /** 超限后是否自动封禁 */
  autoBan: boolean;
  /** 自动封禁时长（小时），0 = 永久 */
  banHours: number;
  /** 2FA 是否已启用 */
  totpEnabled: boolean;
  /** TOTP secret（D1 中存的是用 admin 加密后的密文） */
  totpSecretCipher: string | null;
  /** 恢复码列表（D1 中存的是 hash 后的值，用逗号分隔） */
  totpRecoveryHash: string | null;
  /**
   * Turnstile 模式：
   *   "off"        = 关闭
   *   "on_share"   = 打开分享链接时触发
   *   "on_download"= 点击下载时触发
   *   "both"       = 分享链接打开和下载都可以触发（按阈值）
   */
  turnstileMode: "off" | "on_share" | "on_download" | "both";
  /** 每天每个 IP 触发 Turnstile 的访问次数阈值。0 = 每次都弹。 */
  turnstileThreshold: number;
  /** Turnstile sitekey 覆盖（如果没在 Cloudflare Secret 里配，可在这里写） */
  turnstileSitekeyOverride: string | null;
  /** Turnstile secret（Cloudflare 侧的 SK 开头密钥）—— 用 admin AES-GCM 加密后存 */
  turnstileSecretCipher: string | null;

  // ═══════ OAuth2 下载鉴权 ═══════
  /** 是否启用 OAuth2 下载验证 */
  oauthEnabled: boolean;
  /** 使用哪个 Provider（github/google/microsoft/discord/custom） */
  oauthProvider: string;
  /** OAuth2 Client ID（明文存，可公开） */
  oauthClientId: string;
  /** OAuth2 Client Secret —— 用 admin AES-GCM 加密后存 */
  oauthClientSecretCipher: string | null;
  /** OAuth2 默认 scope */
  oauthScope: string;
  /** 自定义 Provider: authorize_url */
  oauthCustomAuthorizeUrl: string;
  /** 自定义 Provider: token_url */
  oauthCustomTokenUrl: string;
  /** 自定义 Provider: userinfo_url */
  oauthCustomUserinfoUrl: string;
  /** 自定义 Provider: token 返回字段名 */
  oauthCustomTokenField: string;

  // ═══════ 管理员 IP 白名单 ═══════
  /**
   * 允许访问 /admin 和 /api/admin 的 IP 列表（CIDR 或精确 IP，逗号分隔）。
   * 为空 = 不限制；非空 = 仅这些 IP 能访问管理员接口。
   * 这些 IP 的下载流量不受 trafficLimitBytes 限额约束。
   */
  adminIps: string;

  // ═══════ 下载市场首页 ═══════
  /** 是否将根路径 "/" 重定向到下载市场（而不是 /admin）。默认 false。 */
  homeRedirectMarket: boolean;

  // ═══════ 激活码浮动按钮（分享页右上角的卡片图标） ═══════
  /** 是否在分享页显示激活码浮动按钮。默认 true。 */
  codesFloatingButtonEnabled: boolean;
  /** 浮动按钮位置：top-right（右上）或 top-left（左上）。默认 top-right。 */
  codesFloatingButtonPosition: "top-right" | "top-left";

  // ═══════ 管理员第三方 OAuth2 登录（GitHub / Google / Microsoft） ═══════
  /**
   * 各 Provider 的管理员 OAuth 配置（JSON 字符串）。
   * 由 parseAdminOauth() 解析为 AdminOauthConfig；空字符串 = 全部未配置。
   *
   * ⚠️ 兼容旧版：老库只有单一 GitHub 配置（admin_gh_* 键），
   *    getSettings() 会在 admin_oauth 为空时自动把旧键迁移成 GitHub 条目（只读侧迁移）。
   */
  adminOauth: string;

  // ═══════ 存储后端（R2 / S3 兼容） ═══════
  /**
   * 存储后端选择：
   *   null 或 "r2"  —— 使用 Cloudflare R2 binding（默认，零配置）
   *   "s3"          —— 使用通用 S3 兼容存储（需要配置下面所有 s3_* 字段）
   *   "webdav"      —— 使用远程 WebDAV 服务器（坚果云 / 阿里云盘 / OneDrive 等支持 WebDAV 的网盘）
   */
  storageProvider: "r2" | "s3" | "webdav" | null;
  /** S3 endpoint，如 https://s3.amazonaws.com 或 https://oss-cn-hangzhou.aliyuncs.com */
  s3Endpoint: string | null;
  /** S3 region，如 us-east-1、ap-southeast-1 */
  s3Region: string | null;
  /** S3 bucket 名称 */
  s3Bucket: string | null;
  /** S3 Access Key ID（明文存） */
  s3AccessKeyId: string | null;
  /** S3 Secret Access Key —— 用 admin AES-GCM 加密后存 */
  s3SecretKeyCipher: string | null;
  /** S3 addressing style: "path"（默认）或 "virtual" */
  s3AddressingStyle: "path" | "virtual" | null;
  // ═══════ 远程 WebDAV 挂载（出站） ═══════
  /** 远程 WebDAV 服务器 URL，如 https://dav.jianguoyun.com/dav/ 或 https://pan.aliyundrive.com/webdav */
  storageWebdavUrl: string | null;
  /** 远程 WebDAV 认证用户名 */
  storageWebdavUsername: string | null;
  /** 远程 WebDAV 密码 —— 用 admin AES-GCM 加密后存 */
  storageWebdavPasswordCipher: string | null;

  // ═══════ WebDAV 支持 ═══════
  /** 是否启用 WebDAV 服务（挂载点 /webdav/） */
  webdavEnabled: boolean;
  /** WebDAV Basic Auth 用户名（默认 "webdav"） */
  webdavUsername: string;
  /** WebDAV Basic Auth 密码哈希（salt:sha256hex） */
  webdavPasswordHash: string | null;
  /** WebDAV 可访问的根目录（默认 "/" = 全部文件；可设 "/shared" 等限制范围） */
  webdavRootPath: string;

  // ═══════ UI 主题 ═══════
  /** 管理后台 UI 主题："light"（默认白色 Apple 风格）或 "dark"（深色原风格） */
  uiTheme: "light" | "dark";

  // ═══════ 后台标签页自定义 ═══════
  /**
   * 管理后台侧边栏标签页的显示与排序配置（JSON 字符串）。
   * 空字符串 = 使用默认布局。结构：
   *   { version: 1, groups: [ { key, visible, subs?: [ { tab, visible } ] } ] }
   */
  adminTabConfig: string;

  // ═══════ 回收站 ═══════
  /**
   * 回收站保留天数（整数）。文件删除先进回收站（软删），保留期内可还原，
   * 到期后在文件列表/回收站/统计入口懒清理时彻底删除。
   * 0 或负数 = 不自动清理（只手动清空）。默认 7 天。
   */
  trashRetentionDays: number;
}

/* ═══════════ 管理员第三方 OAuth 配置 ═══════════
 * 每个 Provider 一份配置，聚合存进 settings.admin_oauth（JSON 字符串）。
 * 目前支持 GitHub / Google / Microsoft 三家。
 */

/** 支持的管理员 OAuth Provider id（顺序即前端展示顺序） */
export const ADMIN_OAUTH_PROVIDER_IDS = ["github", "google", "microsoft"] as const;
export type AdminOauthProviderId = (typeof ADMIN_OAUTH_PROVIDER_IDS)[number];

/** 单个 Provider 的管理员 OAuth 配置 */
export interface AdminOauthProviderCfg {
  /** OAuth App 的 Client ID（明文存，可公开） */
  clientId: string;
  /** Client Secret —— 用 admin AES-GCM 加密后存；空串 = 未配置 */
  secretCipher: string;
  /** 是否允许用该 Provider 登录后台（需先绑定且已配置） */
  enabled: boolean;
  /** 已绑定的第三方用户 id（字符串），空串 = 未绑定 */
  uid: string;
  /** 已绑定的第三方用户名 / 登录名 */
  login: string;
  /** 已绑定的显示名 */
  name: string;
  /** 已绑定的头像 URL */
  avatar: string;
  /** 绑定时间戳（毫秒），0 = 未绑定 */
  boundAt: number;
}

/** 全部 Provider 的配置集合 */
export type AdminOauthConfig = Record<string, AdminOauthProviderCfg>;

/** 空的单 Provider 配置 */
export function emptyAdminOauthProvider(): AdminOauthProviderCfg {
  return { clientId: "", secretCipher: "", enabled: false, uid: "", login: "", name: "", avatar: "", boundAt: 0 };
}

/** 解析 admin_oauth JSON；非法 / 缺字段时回退为空默认值，保证始终返回完整结构 */
export function parseAdminOauth(raw: string): AdminOauthConfig {
  const out: AdminOauthConfig = {};
  for (const id of ADMIN_OAUTH_PROVIDER_IDS) out[id] = emptyAdminOauthProvider();
  if (!raw) return out;
  try {
    const j = JSON.parse(raw) as { providers?: Record<string, Partial<AdminOauthProviderCfg>> };
    const providers = j?.providers;
    if (providers && typeof providers === "object") {
      for (const id of ADMIN_OAUTH_PROVIDER_IDS) {
        const p = providers[id];
        if (p && typeof p === "object") {
          const base = out[id];
          out[id] = {
            clientId: typeof p.clientId === "string" ? p.clientId : base.clientId,
            secretCipher: typeof p.secretCipher === "string" ? p.secretCipher : base.secretCipher,
            enabled: typeof p.enabled === "boolean" ? p.enabled : base.enabled,
            uid: typeof p.uid === "string" ? p.uid : base.uid,
            login: typeof p.login === "string" ? p.login : base.login,
            name: typeof p.name === "string" ? p.name : base.name,
            avatar: typeof p.avatar === "string" ? p.avatar : base.avatar,
            boundAt: typeof p.boundAt === "number" ? p.boundAt : base.boundAt,
          };
        }
      }
    }
  } catch {
    /* 非法 JSON —— 返回全默认 */
  }
  return out;
}

/** 序列化回 admin_oauth JSON */
export function serializeAdminOauth(cfg: AdminOauthConfig): string {
  const providers: AdminOauthConfig = {};
  for (const id of ADMIN_OAUTH_PROVIDER_IDS) providers[id] = cfg[id] ?? emptyAdminOauthProvider();
  return JSON.stringify({ version: 1, providers });
}

export const DEFAULT_SETTINGS: Settings = {
  siteTitle: "cloud-r2pan",
  trafficLimitBytes: 10 * 1024 ** 3, // 10 GB
  trafficUsedBytes: 0,
  trafficMonth: "",
  maxDownloadsPerIp: 2,
  countWindowHours: 24,
  autoBan: true,
  banHours: 24,
  totpEnabled: false,
  totpSecretCipher: null,
  totpRecoveryHash: null,
  turnstileMode: "off",
  turnstileThreshold: 5,
  turnstileSitekeyOverride: null,
  turnstileSecretCipher: null,
  // OAuth2
  oauthEnabled: false,
  oauthProvider: "github",
  oauthClientId: "",
  oauthClientSecretCipher: null,
  oauthScope: "user:email",
  oauthCustomAuthorizeUrl: "",
  oauthCustomTokenUrl: "",
  oauthCustomUserinfoUrl: "",
  oauthCustomTokenField: "access_token",
  adminIps: "",
  // 下载市场
  homeRedirectMarket: false,
  // 激活码浮动按钮
  codesFloatingButtonEnabled: true,
  codesFloatingButtonPosition: "top-right",
  // 管理员第三方 OAuth2 登录 —— 默认全部未配置、未绑定
  adminOauth: "",
  // 存储后端 —— 默认 R2（向后兼容）
  storageProvider: "r2",
  s3Endpoint: null,
  s3Region: null,
  s3Bucket: null,
  s3AccessKeyId: null,
  s3SecretKeyCipher: null,
  s3AddressingStyle: "path",
  // 远程 WebDAV 挂载 —— 默认未配置
  storageWebdavUrl: null,
  storageWebdavUsername: null,
  storageWebdavPasswordCipher: null,
  // WebDAV —— 默认关闭，启用后通过 Basic Auth 保护
  webdavEnabled: false,
  webdavUsername: "webdav",
  webdavPasswordHash: null,
  webdavRootPath: "/",
  // UI 主题 —— 默认白色 Apple 风格
  uiTheme: "light",
  // 后台标签页自定义 —— 默认空串 = 使用默认布局
  adminTabConfig: "",
  // 回收站保留天数 —— 默认 7 天；0 或负数 = 不自动清理
  trashRetentionDays: 7,
};

function toInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function getSettings(env: Env): Promise<Settings> {
  // ① 命中内存缓存 —— 5 秒内直接返回，零 D1 开销
  const now = Date.now();
  if (_cachedSettings && now - _cachedAt < SETTINGS_CACHE_TTL_MS) {
    return _cachedSettings;
  }

  const { results } = await env.db.prepare(
    "SELECT key, value FROM settings"
  ).all<{ key: string; value: string }>();
  const map = new Map((results ?? []).map((r) => [r.key, r.value]));

  // ── 本月已用流量：以 traffic_stats 每日账本为准现算（2026-10-21 精确版记账）──
  // addTraffic 只写账本（每请求 1 行写），月用量 = 当月每日 bytes 之和，跨月天然归零。
  // 切换基线（traffic_baseline_*，由部署/「重置本月流量」维护）：
  //   基线当月：已用量 = 基线值（可为负，重置时用）+ 基线日之后整日的账本和；
  //   基线保证计数器时代的存量不被追溯重算——历史压测流量不回头触发限额闸门。
  // 次月起基线失效，纯账本现算。账本每月至多 31 行、且有 5 秒缓存，读开销可忽略。
  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthStart = currentMonth + "-01";
  const nextMonthStart = new Date(
    Date.UTC(Number(currentMonth.slice(0, 4)), Number(currentMonth.slice(5, 7)), 1)
  ).toISOString().slice(0, 7) + "-01";
  const baselineMonth = map.get("traffic_baseline_month") ?? "";
  const baselineDay = map.get("traffic_baseline_day") ?? "";
  const baselineSigned = map.has("traffic_baseline_bytes")
    ? Number(map.get("traffic_baseline_bytes")) || 0
    : 0;
  const statsRow = await env.db.prepare(
    "SELECT COALESCE(SUM(bytes), 0) AS total, COALESCE(SUM(CASE WHEN day > ?1 THEN bytes ELSE 0 END), 0) AS after_baseline FROM traffic_stats WHERE day >= ?2 AND day < ?3"
  ).bind(baselineDay, monthStart, nextMonthStart).first<{ total: number; after_baseline: number }>();
  const trafficUsedBytes = baselineMonth === currentMonth && baselineDay
    ? Math.max(0, baselineSigned + (statsRow?.after_baseline ?? 0))
    : (statsRow?.total ?? 0);
  const trafficMonth = currentMonth;

  // ── 管理员第三方 OAuth 配置 ──────────────────────────────
  // 优先读新的聚合键 admin_oauth；为空时把旧的单一 GitHub 键读侧迁移成 GitHub 条目，
  // 老部署无需手动改库即可继续使用原 GitHub 绑定与配置。
  let adminOauth = map.get("admin_oauth") ?? "";
  if (!adminOauth) {
    const legacy: AdminOauthProviderCfg = {
      clientId: map.get("admin_gh_client_id") ?? "",
      secretCipher: map.get("admin_gh_client_secret_cipher") ?? "",
      enabled: map.get("admin_gh_login_enabled") === "1",
      uid: map.get("admin_gh_uid") ?? "",
      login: map.get("admin_gh_login") ?? "",
      name: map.get("admin_gh_name") ?? "",
      avatar: map.get("admin_gh_avatar") ?? "",
      boundAt: map.get("admin_gh_bound_at") ? Number(map.get("admin_gh_bound_at")) : 0,
    };
    if (legacy.clientId || legacy.secretCipher || legacy.uid) {
      adminOauth = serializeAdminOauth({
        github: legacy,
        google: emptyAdminOauthProvider(),
        microsoft: emptyAdminOauthProvider(),
      });
    }
  }

  const result: Settings = {
    siteTitle: map.get("site_title") ?? DEFAULT_SETTINGS.siteTitle,
    trafficLimitBytes: toInt(map.get("traffic_limit_bytes"), DEFAULT_SETTINGS.trafficLimitBytes),
    trafficUsedBytes,
    trafficMonth,
    maxDownloadsPerIp: toInt(map.get("max_downloads_per_ip"), DEFAULT_SETTINGS.maxDownloadsPerIp),
    countWindowHours: toInt(map.get("count_window_hours"), DEFAULT_SETTINGS.countWindowHours),
    autoBan: (map.get("auto_ban") ?? "1") === "1",
    banHours: toInt(map.get("ban_hours"), DEFAULT_SETTINGS.banHours),
    totpEnabled: map.get("totp_enabled") === "1",
    totpSecretCipher: map.get("totp_secret_cipher") ?? null,
    totpRecoveryHash: map.get("totp_recovery_hash") ?? null,
    turnstileMode: (map.get("turnstile_mode") ?? DEFAULT_SETTINGS.turnstileMode) as Settings["turnstileMode"],
    turnstileThreshold: toInt(map.get("turnstile_threshold"), DEFAULT_SETTINGS.turnstileThreshold),
    turnstileSitekeyOverride: map.get("turnstile_sitekey_override") ?? null,
    turnstileSecretCipher: map.get("turnstile_secret_cipher") ?? null,
    // OAuth2
    oauthEnabled: map.get("oauth_enabled") === "1",
    oauthProvider: map.get("oauth_provider") ?? DEFAULT_SETTINGS.oauthProvider,
    oauthClientId: map.get("oauth_client_id") ?? "",
    oauthClientSecretCipher: map.get("oauth_client_secret_cipher") ?? null,
    oauthScope: map.get("oauth_scope") ?? DEFAULT_SETTINGS.oauthScope,
    oauthCustomAuthorizeUrl: map.get("oauth_custom_authorize_url") ?? "",
    oauthCustomTokenUrl: map.get("oauth_custom_token_url") ?? "",
    oauthCustomUserinfoUrl: map.get("oauth_custom_userinfo_url") ?? "",
    oauthCustomTokenField: map.get("oauth_custom_token_field") ?? DEFAULT_SETTINGS.oauthCustomTokenField,
    adminIps: map.get("admin_ips") ?? "",
    homeRedirectMarket: map.get("home_redirect_market") === "1",
    // 激活码浮动按钮
    codesFloatingButtonEnabled: map.get("codes_floating_button_enabled") !== "0", // 默认 true
    codesFloatingButtonPosition: (map.get("codes_floating_button_position") ?? DEFAULT_SETTINGS.codesFloatingButtonPosition) as Settings["codesFloatingButtonPosition"],
    // 管理员第三方 OAuth2 登录
    adminOauth,
    // 存储后端
    storageProvider: (map.get("storage_provider") ?? "r2") as Settings["storageProvider"],
    s3Endpoint: map.get("s3_endpoint") ?? null,
    s3Region: map.get("s3_region") ?? null,
    s3Bucket: map.get("s3_bucket") ?? null,
    s3AccessKeyId: map.get("s3_access_key_id") ?? null,
    s3SecretKeyCipher: map.get("s3_secret_key_cipher") ?? null,
    s3AddressingStyle: (map.get("s3_addressing_style") ?? "path") as Settings["s3AddressingStyle"],
    // 远程 WebDAV 挂载
    storageWebdavUrl: map.get("storage_webdav_url") ?? null,
    storageWebdavUsername: map.get("storage_webdav_username") ?? null,
    storageWebdavPasswordCipher: map.get("storage_webdav_password_cipher") ?? null,
    // WebDAV
    webdavEnabled: map.get("webdav_enabled") === "1",
    webdavUsername: map.get("webdav_username") ?? DEFAULT_SETTINGS.webdavUsername,
    webdavPasswordHash: map.get("webdav_password_hash") ?? null,
    webdavRootPath: map.get("webdav_root_path") ?? DEFAULT_SETTINGS.webdavRootPath,
    // UI 主题
    uiTheme: (map.get("ui_theme") ?? DEFAULT_SETTINGS.uiTheme) as Settings["uiTheme"],
    // 后台标签页自定义
    adminTabConfig: map.get("admin_tab_config") ?? "",
  };

  // 回收站保留天数：允许 0 / 负数（= 不自动清理）；非法值回退默认 7 天
  {
    const raw = map.get("trash_retention_days");
    const n = raw === undefined ? NaN : Number(raw);
    result.trashRetentionDays = Number.isFinite(n) ? Math.floor(n) : DEFAULT_SETTINGS.trashRetentionDays;
  }

  // ② 写入内存缓存
  _cachedSettings = result;
  _cachedAt = Date.now();
  return result;
}

/** 更新设置（仅覆盖传入的字段） */
export async function updateSettings(env: Env, patch: Partial<Record<string, string>>): Promise<void> {
  const upserts = Object.entries(patch).map(([key, value]) =>
    env.db.prepare(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(key, String(value))
  );
  if (upserts.length > 0) await env.db.batch(upserts);
  // 主动失效缓存 —— 确保后续请求立即读到新值
  invalidateSettingsCache();
}

/**
 * 记录一次下载请求产生的流量（精确版记账，2026-10-21）。
 *
 * 只写 traffic_stats 一行：字节逐段精确累加（分毫不差）；
 * downloads 仅在下载起始请求（非续传分片）时 +1 —— 后台「下载次数」
 * 从此是真实下载数，不再是请求数虚高（旧口径曾虚高近 6 倍）。
 * 本月已用流量改由 getSettings 从每日账本现算，不再单独维护计数器：
 * 每段请求的 D1 写从 3 行降到 1 行（每日写额度 10 万行是稀缺项，
 * 加速下载 14 段曾一次烧掉约 43 行写）。
 */
export async function addTraffic(env: Env, bytes: number, isDownloadStart: boolean): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  await env.db.prepare(
    "INSERT INTO traffic_stats(day, bytes, downloads) VALUES(?1, ?2, ?3) ON CONFLICT(day) DO UPDATE SET bytes = bytes + excluded.bytes, downloads = downloads + excluded.downloads"
  ).bind(day, bytes, isDownloadStart ? 1 : 0).run();
}
