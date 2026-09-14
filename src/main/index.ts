import { initCommand } from './command'
import { runScript, scripts, updateEnabledSourceLogout } from './isolate'
import { initOnlineResource } from './onlineResource'
import { app, configuration, console, t } from './shared/hostAPI'
import { checkFiles, getScript } from './shared/lxSourceManage'

void initOnlineResource()

const state = {
  enabledScripts: [] as string[],
  enabledSourceLogout: false,
  enabledHighQuality: true,
}

const reportLoadError = (name: string, message: string) => {
  console.error(t('error.loadScriptFailed', { name, message }))
  void app.showMessage(t('error.loadScriptFailed', { name, message }), {
    type: 'error',
  })
}

const loadScripts = async (ids: string[]) => {
  const infos = (await configuration.getConfigs<[LXScriptInfoFull[]]>(['importedScriptSources']))[0] ?? []
  const infoMap = new Map(infos.map((info) => [info.id, info]))
  for (const id of ids) {
    if (scripts.some((script) => script.id === id)) continue
    const info = infoMap.get(id)
    if (!info) {
      console.error(`No script info found for id ${id}`)
      continue
    }
    try {
      const script = await getScript(info.id)
      await runScript(info.id, info, script, state.enabledSourceLogout, state.enabledHighQuality)
    } catch (error) {
      reportLoadError(info.name || info.id, (error as Error).message)
    }
  }
}

const applyEnabledScripts = async (enabledIds: string[]) => {
  for (const script of [...scripts]) {
    if (enabledIds.includes(script.id)) continue
    await script.destroy().catch(() => {})
  }
  await loadScripts(enabledIds)
}

const reloadAllScripts = async () => {
  for (const script of [...scripts]) {
    await script.destroy().catch(() => {})
  }
  await loadScripts(state.enabledScripts)
}

const initScripts = async () => {
  const [config = [], infos = [], enabledSourceLogout = false, enabledHighQuality = true] = await configuration.getConfigs<
    [string[], LXScriptInfoFull[], boolean, boolean]
  >(['enabledScripts', 'importedScriptSources', 'enabledSourceLogout', 'enableHighQuality'])

  state.enabledScripts = config
  state.enabledSourceLogout = enabledSourceLogout
  state.enabledHighQuality = enabledHighQuality

  void checkFiles(infos)

  await loadScripts(config)

  configuration.onConfigChanged(async (keys, newConfig) => {
    // Rebuilding every script isolate is required when the quality whitelist changes.
    let needReload = false
    if (keys.includes('enabledSourceLogout')) {
      state.enabledSourceLogout = (newConfig.enabledSourceLogout as boolean) || false
      await updateEnabledSourceLogout(state.enabledSourceLogout)
    }
    if (keys.includes('enableHighQuality')) {
      state.enabledHighQuality = (newConfig.enableHighQuality as boolean | null) ?? true
      needReload = true
    }
    if (keys.includes('enabledScripts')) {
      state.enabledScripts = (newConfig.enabledScripts as string[] | null) || []
      await applyEnabledScripts(state.enabledScripts)
      return
    }
    if (needReload) await reloadAllScripts()
  })
}

initScripts().catch((error) => {
  console.error(t('error.initScriptsFailed', { message: (error as Error).message }))
})

initCommand().catch((error) => {
  console.error(`Failed to initialize commands: ${(error as Error).message}`)
})
