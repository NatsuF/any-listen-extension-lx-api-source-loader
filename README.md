# API Source Loader

Music source loader

---

## Fork 补丁：解锁高音质档位

上游仓库：[any-listen/any-listen-extension-lx-api-source-loader](https://github.com/any-listen/any-listen-extension-lx-api-source-loader)
本 fork 基线：`baseline-upstream-0.1.7`（tag），补丁分支：`master-quality`。

### 背景

any-listen 内核本身支持 8 个音质档位：

```
['128k', '192k', '320k', 'wav', 'flac', 'flac24bit', 'dolby', 'master']
```

但这个插件在 `src/isolate-preload/setupEnv.ts` 里维护了一份白名单，只放行 `128k / 320k / flac / flac24bit`。
脚本上报的音质要与这份白名单取交集，所以即使脚本声明了 `master`（母带）或 `dolby`（全景声），也会被裁掉，
请求最终沿 `master → dolby → flac24bit` 降级，稳定落在 HR。UI 上选「母带」不会报错，但拿到的仍是无损。

### 改动内容

| 文件 | 改动 |
| --- | --- |
| `src/isolate-preload/setupEnv.ts` | 白名单改为动态生成，开启时追加 `192k / wav / dolby / master`；接入音质键名归一化与反向翻译 |
| `src/isolate-preload/qualityAlias.ts` | 新增。脚本侧键名 ↔ 内核档位的双向别名表，含 `atmos_plus` / `hires` 的落位规则 |
| `src/isolate-preload/utils.ts` | 新增 `setEnabledHighQuality` / `getEnabledHighQuality` 状态位 |
| `src/isolate-preload/exposeObject.ts` | 暴露 `setEnabledHighQuality` 供主进程下发 |
| `src/main/isolate/index.ts` | `runScript` 增加 `enabledHighQuality` 参数 |
| `src/main/index.ts` | 读取配置并在开关变化时自动重启脚本（白名单变化必须重建 isolate） |
| `config.ts` / `i18n/*.json` | 新增设置项「解锁高音质档位」，默认开启 |
| `src/main/onlineResource/index.ts` | 取链出口：宿主代理拒绝厂商容器扩展名时，以别名扩展名重试（0.1.11） |
| `.github/workflows/release.yml` | 改为 `master-quality` 分支触发、签名密钥预检、类型检查、包体自检、上传构件 |
| `scripts/verify-alix.mjs` | 新增发布前自检，复刻宿主的取公钥与验签逻辑 |

仍然保留原有的交集判定：`supportQualitys ∩ 脚本自身声明`，因此脚本没声明 `master` 的源不会受影响，
取链失败时依旧按 `master → dolby → flac24bit` 递归降级，不会比上游更容易失败。

### 音质键名归一化（0.1.10）

只放宽白名单还不够。any-listen 内核的 8 个档位键是固定的一组词：

```
128k / 192k / 320k / wav / flac / flac24bit / dolby / master
```

而自定义源脚本按自己服务端的叫法声明档位，于是出现**三套词表互不对齐**的情况：

| 内核档位键 | 列表标签 | 设置项文案 | 脚本常见写法 |
| --- | --- | --- | --- |
| `master` | `MASTER` | 母带 | `master` |
| `dolby` | `ATMOS` | 全景声 | **`atmos`** |
| `flac24bit` | `HR` | FLAC 24bit | `flac24bit` / **`hires`** |
| — | — | （无对应档位） | `atmos_plus` |

上游只做「字面交集」过滤，名字对不上就整档丢弃，后果有两个：

- 设置里选「全景声」→ 内核发 `dolby` → 脚本只认 `atmos` → 逐档降级到 `flac24bit`；
- 脚本其实能取的 `atmos` / `hires` / `atmos_plus` 没有任何档位能触发。

0.1.10 在隔离层加了一层双向别名（`qualityAlias.ts`）：

| 脚本键 | 归一化为内核档位 | 取链时再翻回脚本键 |
| --- | --- | --- |
| `master` | `master` | `master` |
| `atmos_plus` | `master`（仅当脚本未声明 `master` 时兜底） | `atmos_plus` |
| `atmos` | `dolby` | `atmos` |
| `hires` / `hi_res` / `flac_24bit` | `flac24bit` | `flac24bit` 或 `hires` 等原写法 |
| `flac` / `wav` / `320k` / `192k` / `128k` | 同名 | 同名 |

要点：

- **注册时归一、取链时反归一**，所以脚本收到的仍是它自己声明的那个字符串，服务端不会看到陌生档位。
- 优先级由表内顺序决定：同组内第一个被声明的写法生效，其余记为 `shadowed`（例如同时声明 `master` 与 `atmos_plus` 时 `master` 胜出）。
- 认不出的键记为 `dropped`，并在扩展日志里输出一行 `[quality] <source>: alias … | shadowed … | dropped …`，便于排查。
- 键名大小写不敏感，但**回传时保留脚本声明的原始大小写**。
- 关闭「解锁高音质档位」后，`dolby` / `master` 会被 `supportQualitys` 再次拦掉，行为与上游一致。

### 宿主代理扩展名白名单导致的「播放失败」（0.1.11）

拿到 URL 之后还有一关：插件必须把 URL 交给宿主的本地代理（`musicUtils.createProxyUrl`），
播放器实际播放的是代理地址 `al-ps-host:/p_static/<sha256><ext>`。而宿主的 `generateName()` 是这样做的：

```ts
const ext = extname(url)                       // path.extname(url.split('?')[0])
if (ext && !checkAllowedExt(ext)) throw new Error('Not allowed file type')
```

白名单只有 `MEDIA_FILE_TYPES`（`mp3 flac ogg oga wav m4a`）+ `PIC_FILE_TYPES`（图片）。
酷我返回的是 `.mgg`（其实是 OGG 容器），腾讯高音质会返回 `.mflac`（其实是 FLAC），
**都不在白名单里 → 抛错 → 整条取链作废 → 播放失败**，日志里只有一行：

```
ERROR [xxx - 歌名(kw, type: flac24bit)] Request failed
INFO  歌名, kw, master: http://car-er.kuwo.cn/....mgg      ← 有 URL
（缺 proxy: 那一行 → createProxy 抛错了）
```

> 排查技巧：`name, source, quality: url` 这行有、紧跟着的 `proxy:` 那行没有，就是被这个白名单拦了。

0.1.11 的处理：

| 情况 | 处理 |
| --- | --- |
| 扩展名在白名单内 | 原样走代理 |
| 扩展名不在白名单、URL 无 query | 以别名扩展名重试：`.mgg` → `.ogg`、`.mflac` → `.flac`、其它 → `.ogg` |
| 扩展名不在白名单、URL 带 query | 原样交出原始 URL（fragment 别名会吞掉 `?vkey=…` 这类凭据，不能改） |
| 别名重试也失败 | 兜底交出原始 URL，不丢歌 |
| 链接本身死了（`verifyResource` 失败） | 继续抛错，保留宿主换源重试 |

别名是以 **URL fragment** 形式附加的，这一点是关键：

```
http://car-er.kuwo.cn/....mgg  →  http://car-er.kuwo.cn/....mgg#.ogg
```

- 宿主 `extname()` 只 `split('?')[0]`，**不剥掉 `#`**，所以白名单看到的是 `.ogg`，检查通过；
- undici 真正发包时会丢掉 fragment，源站收到的路径与 query **一字未改**（实测 kuwo 返回码与 `Content-Range` 完全一致）。

试过但**不可行**的两种改写（源站会 403），记在这里免得重走：

- 末尾点转义 `....mgg` → `....%2Emgg`
- 分号参数 `....mgg` → `....mgg;.flac`

### 使用

1. 到 Releases 下载 `lx-api-source-loader_v0.1.11.alix`，在 any-listen 中手动安装。
2. 扩展设置里「解锁高音质档位」默认已开启，关闭即恢复上游行为。
3. 主程序设置里把播放音质选到「母带」或「全景声」——注意内核默认音质是 `128k`，必须手动改。

最终能否真的拿到母带，取决于你导入的音源脚本自身是否支持；插件只决定"把哪个 type 传下去"。
如果某首歌在该平台上没有对应档位，付费音源会返回 HTTP 500，宿主对 5xx 会重试几次，
所以会出现约 5 秒的等待后落到其它源/更低档位——这是正常的降级，不是插件故障。

### 安装失败排查（0.1.8）

0.1.8 的包体签名格式有误，安装时报：

```
扩展包安装失败：error:09000064:PEM routines:OPENSSL_internal:BAD_BASE64_DECODE
```

原因：`extension-kit` 把 `${signature}\n${PUB_KEY}` 原样写入包内 `sig` 文件，而 any-listen 是这样读的：

```ts
const [sign, pubKey] = sigFile.split('\n')   // 只取第 2 行
verify(extBundle, `-----BEGIN PUBLIC KEY-----\n${pubKey}\n-----END PUBLIC KEY-----`, sign)
```

所以 `PUB_KEY` 必须是**单行 base64 正文**（不含 PEM 头尾、不含换行）。`sig` 里若放了完整多行 PEM，
第 2 行就变成 `-----BEGIN PUBLIC KEY-----`，被再套一层头尾后中间不是 base64，PEM 解码直接失败。0.1.9 已修复，
并加了 `npm run verify` 在 CI 里拦住同类问题。

### 构建

仓库 Secrets 需配置两个 key，否则 `extension-kit` 会拒绝打包：

| Secret | 格式 | 说明 |
| --- | --- | --- |
| `PRI_KEY` | 完整 PEM（多行 PKCS#8 私钥） | 用于签名 |
| `PUB_KEY` | **单行 base64 正文**，不含 `-----BEGIN/END-----` | 会被原样写进 `sig` 第 2 行 |

密钥算法必须是 **RSA**，不能用 Ed25519：`extension-kit` 走的是 `crypto.createSign('SHA256')`，
Ed25519 不支持这种 digest 组合（`ERR_CRYPTO_UNSUPPORTED_OPERATION`），构建会在打包步骤直接失败。

推送到 `master-quality` 分支即可触发 Actions 构建并发布 prerelease。

## License

Apache License 2.0（继承上游，仅在镜像基础上的补丁部分同样适用）
