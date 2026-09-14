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
| `src/isolate-preload/setupEnv.ts` | 白名单改为动态生成，开启时追加 `192k / wav / dolby / master` |
| `src/isolate-preload/utils.ts` | 新增 `setEnabledHighQuality` / `getEnabledHighQuality` 状态位 |
| `src/isolate-preload/exposeObject.ts` | 暴露 `setEnabledHighQuality` 供主进程下发 |
| `src/main/isolate/index.ts` | `runScript` 增加 `enabledHighQuality` 参数 |
| `src/main/index.ts` | 读取配置并在开关变化时自动重启脚本（白名单变化必须重建 isolate） |
| `config.ts` / `i18n/*.json` | 新增设置项「解锁高音质档位」，默认开启 |
| `.github/workflows/release.yml` | 改为 `master-quality` 分支触发、签名密钥预检、类型检查、包体自检、上传构件 |
| `scripts/verify-alix.mjs` | 新增发布前自检，复刻宿主的取公钥与验签逻辑 |

仍然保留原有的交集判定：`supportQualitys ∩ 脚本自身声明`，因此脚本没声明 `master` 的源不会受影响，
取链失败时依旧按 `master → dolby → flac24bit` 递归降级，不会比上游更容易失败。

### 使用

1. 到 Releases 下载 `lx-api-source-loader_v0.1.9.alix`，在 any-listen 中手动安装。
2. 扩展设置里「解锁高音质档位」默认已开启，关闭即恢复上游行为。
3. 主程序设置里把播放音质选到「母带」或「全景声」——注意内核默认音质是 `128k`，必须手动改。

最终能否真的拿到母带，取决于你导入的音源脚本自身是否支持；插件只决定"把哪个 type 传下去"。

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
