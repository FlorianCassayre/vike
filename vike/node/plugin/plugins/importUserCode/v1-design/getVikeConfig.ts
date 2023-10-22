export { getVikeConfig }
export { reloadVikeConfig }
export { vikeConfigDependencies }
export { isVikeConfigFile }

import {
  assertPosixPath,
  assert,
  isObject,
  assertUsage,
  toPosixPath,
  assertWarning,
  objectEntries,
  hasProp,
  arrayIncludes,
  assertIsNotProductionRuntime,
  getMostSimilar,
  isNpmPackageImport,
  joinEnglish,
  lowerFirst,
  scriptFileExtensions,
  mergeCumulativeValues,
  requireResolve
} from '../../../utils.js'
import path from 'path'
import type {
  PageConfigGlobalBuildTime,
  ConfigEnvInternal,
  ConfigValueSource,
  ConfigValueSources,
  ConfigEnv,
  PageConfigBuildTime,
  ConfigValues,
  DefinedAt,
  DefinedAtFileInfo,
  DefinedAtFile
} from '../../../../../shared/page-configs/PageConfig.js'
import type { Config } from '../../../../../shared/page-configs/Config.js'
import {
  configDefinitionsBuiltIn,
  type ConfigDefinitionInternal,
  configDefinitionsBuiltInGlobal,
  type ConfigNameGlobal
} from './getVikeConfig/configDefinitionsBuiltIn.js'
import glob from 'fast-glob'
import type { ExtensionResolved } from '../../../../../shared/ConfigVike.js'
import {
  getLocationId,
  getFilesystemRouteString,
  getFilesystemRouteDefinedBy,
  isInherited,
  sortAfterInheritanceOrder,
  isGlobalLocation,
  applyFilesystemRoutingRootEffect
} from './getVikeConfig/filesystemRouting.js'
import { isTmpFile, transpileAndExecuteFile } from './transpileAndExecuteFile.js'
import { ImportData, parseImportData } from './replaceImportStatements.js'
import { isConfigInvalid, isConfigInvalid_set } from '../../../../runtime/renderPage/isConfigInvalid.js'
import { getViteDevServer } from '../../../../runtime/globalContext.js'
import { logConfigError, logConfigErrorRecover } from '../../../shared/loggerNotProd.js'
import {
  removeSuperfluousViteLog_enable,
  removeSuperfluousViteLog_disable
} from '../../../shared/loggerVite/removeSuperfluousViteLog.js'
import { type FilePath, getFilePathToShowToUser } from './getFilePathToShowToUser.js'
import pc from '@brillout/picocolors'
import { getConfigDefinedAtString } from '../../../../../shared/page-configs/utils.js'
import {
  assertExportsOfConfigFile,
  assertExportsOfValueFile
} from '../../../../../shared/page-configs/assertExports.js'
import { getConfigValueSerialized } from './getVirtualFilePageConfigs.js'

assertIsNotProductionRuntime()

type InterfaceFile = InterfaceConfigFile | InterfaceValueFile
type InterfaceFileCommons = {
  filePath: FilePath
  configMap: Record<ConfigName, { configValue?: unknown }>
}
// +config.h.js
type InterfaceConfigFile = InterfaceFileCommons & {
  isConfigFile: true
  isValueFile: false
  extendsFilePaths: string[]
  isConfigExtend: boolean
}
// +{configName}.js
type InterfaceValueFile = InterfaceFileCommons & {
  isConfigFile: false
  isValueFile: true
  configName: string
  // All value files are +{configName}.js file living in user-land => filePathRelativeToUserRootDir is always defined
  filePath: UserFilePath
}
type ConfigName = string
type LocationId = string
type InterfaceFilesByLocationId = Record<LocationId, InterfaceFile[]>

type VikeConfig = {
  pageConfigs: PageConfigBuildTime[]
  pageConfigGlobal: PageConfigGlobalBuildTime
  globalVikeConfig: Record<string, unknown>
}

type ConfigDefinitionsIncludingCustom = Record<string, ConfigDefinitionInternal>

let devServerIsCorrupt = false
let wasConfigInvalid: boolean | null = null
let vikeConfigPromise: Promise<VikeConfig> | null = null
const vikeConfigDependencies: Set<string> = new Set()
const filesEnv: Map<string, { configEnv: ConfigEnvInternal; configName: string }[]> = new Map()
function reloadVikeConfig(userRootDir: string, outDirRoot: string, extensions: ExtensionResolved[]) {
  vikeConfigDependencies.clear()
  filesEnv.clear()
  vikeConfigPromise = loadVikeConfig_withErrorHandling(userRootDir, outDirRoot, true, extensions, true)
  handleReloadSideEffects()
}
async function handleReloadSideEffects() {
  wasConfigInvalid = isConfigInvalid
  const vikeConfigPromisePrevious = vikeConfigPromise
  try {
    await vikeConfigPromise
  } catch (err) {
    // handleReloadSideEffects() is only called in dev.
    // In dev, if loadVikeConfig_withErrorHandling() throws an error, then it's a vike bug.
    console.error(err)
    assert(false)
  }
  if (vikeConfigPromise !== vikeConfigPromisePrevious) {
    // Let the next handleReloadSideEffects() call handle side effects
    return
  }
  if (!isConfigInvalid) {
    if (wasConfigInvalid) {
      wasConfigInvalid = false
      logConfigErrorRecover()
    }
    if (devServerIsCorrupt) {
      devServerIsCorrupt = false
      const viteDevServer = getViteDevServer()
      assert(viteDevServer)
      removeSuperfluousViteLog_enable()
      await viteDevServer.restart(true)
      removeSuperfluousViteLog_disable()
    }
  }
}
async function getVikeConfig(
  userRootDir: string,
  outDirRoot: string,
  isDev: boolean,
  extensions: ExtensionResolved[],
  tolerateInvalidConfig = false
): Promise<VikeConfig> {
  if (!vikeConfigPromise) {
    vikeConfigPromise = loadVikeConfig_withErrorHandling(
      userRootDir,
      outDirRoot,
      isDev,
      extensions,
      tolerateInvalidConfig
    )
  }
  return await vikeConfigPromise
}

async function loadInterfaceFiles(
  userRootDir: string,
  outDirRoot: string,
  isDev: boolean,
  extensions: ExtensionResolved[]
): Promise<InterfaceFilesByLocationId> {
  const plusFiles = await findPlusFiles(userRootDir, [outDirRoot], isDev, extensions)
  const configFiles: UserFilePath[] = []
  const valueFiles: UserFilePath[] = []
  plusFiles.forEach((f) => {
    if (getConfigName(f.filePathRelativeToUserRootDir) === 'config') {
      configFiles.push(f)
    } else {
      valueFiles.push(f)
    }
  })

  let interfaceFilesByLocationId: InterfaceFilesByLocationId = {}

  // Config files
  await Promise.all(
    configFiles.map(async ({ filePathAbsolute, filePathRelativeToUserRootDir }) => {
      const configFilePath = {
        filePathAbsolute: filePathAbsolute,
        filePathRelativeToUserRootDir: filePathRelativeToUserRootDir,
        importPathAbsolute: null
      }
      const { configFile, extendsConfigs } = await loadConfigFile(configFilePath, userRootDir, [])
      const interfaceFile = getInterfaceFileFromConfigFile(configFile, false)

      const locationId = getLocationId(filePathRelativeToUserRootDir)
      interfaceFilesByLocationId[locationId] = interfaceFilesByLocationId[locationId] ?? []
      interfaceFilesByLocationId[locationId]!.push(interfaceFile)
      extendsConfigs.forEach((extendsConfig) => {
        const interfaceFile = getInterfaceFileFromConfigFile(extendsConfig, true)
        interfaceFilesByLocationId[locationId]!.push(interfaceFile)
      })
    })
  )

  // Value files
  await Promise.all(
    valueFiles.map(async ({ filePathAbsolute, filePathRelativeToUserRootDir }) => {
      const configName = getConfigName(filePathRelativeToUserRootDir)
      assert(configName)
      const interfaceFile: InterfaceValueFile = {
        filePath: {
          filePathRelativeToUserRootDir,
          filePathAbsolute,
          importPathAbsolute: null
        },
        configMap: {
          [configName]: {}
        },
        isConfigFile: false,
        isValueFile: true,
        configName
      }
      {
        // We don't have access to custom config definitions yet
        //  - We load +{configName}.js later
        //  - But we do need to eagerly load +meta.js (to get all the custom config definitions)
        const configDef = getConfigDefinitionOptional(configDefinitionsBuiltIn, configName)
        if (configDef?.env === 'config-only') {
          await loadValueFile(interfaceFile, configName, userRootDir)
        }
      }
      {
        const locationId = getLocationId(filePathRelativeToUserRootDir)
        interfaceFilesByLocationId[locationId] = interfaceFilesByLocationId[locationId] ?? []
        interfaceFilesByLocationId[locationId]!.push(interfaceFile)
      }
    })
  )

  return interfaceFilesByLocationId
}
function getConfigDefinition(
  configDefinitionsRelevant: Record<string, ConfigDefinitionInternal>,
  configName: string,
  definedByFile: string
): ConfigDefinitionInternal {
  const configDef = configDefinitionsRelevant[configName]
  assertConfigExists(configName, Object.keys(configDefinitionsRelevant), definedByFile)
  assert(configDef)
  return configDef
}
function getConfigDefinitionOptional(
  configDefinitions: Record<string, ConfigDefinitionInternal>,
  configName: string
): null | ConfigDefinitionInternal {
  return configDefinitions[configName] ?? null
}
async function loadValueFile(interfaceValueFile: InterfaceValueFile, configName: string, userRootDir: string) {
  const { fileExports } = await transpileAndExecuteFile(interfaceValueFile.filePath, true, userRootDir)
  const filePathToShowToUser = getFilePathToShowToUser(interfaceValueFile.filePath)
  assertExportsOfValueFile(fileExports, filePathToShowToUser, configName)
  Object.entries(fileExports).forEach(([exportName, configValue]) => {
    const configName_ = exportName === 'default' ? configName : exportName
    interfaceValueFile.configMap[configName_] = { configValue }
  })
}
function getInterfaceFileFromConfigFile(configFile: ConfigFile, isConfigExtend: boolean): InterfaceFile {
  const { fileExports, filePath, extendsFilePaths } = configFile
  const interfaceFile: InterfaceConfigFile = {
    filePath,
    configMap: {},
    isConfigFile: true,
    isValueFile: false,
    isConfigExtend,
    extendsFilePaths
  }
  const filePathToShowToUser = getFilePathToShowToUser(filePath)
  assertExportsOfConfigFile(fileExports, filePathToShowToUser)
  Object.entries(fileExports.default).forEach(([configName, configValue]) => {
    interfaceFile.configMap[configName] = { configValue }
  })
  return interfaceFile
}

async function loadVikeConfig_withErrorHandling(
  userRootDir: string,
  outDirRoot: string,
  isDev: boolean,
  extensions: ExtensionResolved[],
  tolerateInvalidConfig: boolean
): Promise<VikeConfig> {
  let hasError = false
  let ret: VikeConfig | undefined
  let err: unknown
  try {
    ret = await loadVikeConfig(userRootDir, outDirRoot, isDev, extensions)
  } catch (err_) {
    hasError = true
    err = err_
  }
  if (!hasError) {
    assert(ret)
    assert(err === undefined)
    isConfigInvalid_set(false)
    return ret
  } else {
    assert(ret === undefined)
    assert(err)
    isConfigInvalid_set(true)
    if (!isDev) {
      assert(getViteDevServer() === null)
      throw err
    } else {
      logConfigError(err)
      if (!tolerateInvalidConfig) {
        devServerIsCorrupt = true
      }
      const dummyData: VikeConfig = {
        pageConfigs: [],
        pageConfigGlobal: {
          configValueSources: {}
        },
        globalVikeConfig: {}
      }
      return dummyData
    }
  }
}
async function loadVikeConfig(
  userRootDir: string,
  outDirRoot: string,
  isDev: boolean,
  extensions: ExtensionResolved[]
): Promise<VikeConfig> {
  const interfaceFilesByLocationId = await loadInterfaceFiles(userRootDir, outDirRoot, isDev, extensions)

  const { globalVikeConfig, pageConfigGlobal } = getGlobalConfigs(interfaceFilesByLocationId, userRootDir)

  const pageConfigs: PageConfigBuildTime[] = await Promise.all(
    Object.entries(interfaceFilesByLocationId)
      .filter(([_pageId, interfaceFiles]) => isDefiningPage(interfaceFiles))
      .map(async ([locationId]) => {
        const interfaceFilesRelevant = getInterfaceFilesRelevant(interfaceFilesByLocationId, locationId)

        const configDefinitionsRelevant = getConfigDefinitions(interfaceFilesRelevant)

        // Load value files of custom config-only configs
        await Promise.all(
          getInterfaceFileList(interfaceFilesRelevant).map(async (interfaceFile) => {
            if (!interfaceFile.isValueFile) return
            const { configName } = interfaceFile
            if (isGlobalConfig(configName)) return
            const configDef = getConfigDefinition(
              configDefinitionsRelevant,
              configName,
              getFilePathToShowToUser(interfaceFile.filePath)
            )
            if (configDef.env !== 'config-only') return
            const isAlreadyLoaded = interfacefileIsAlreaydLoaded(interfaceFile)
            if (isAlreadyLoaded) return
            // Value files for built-in confg-only configs should have already been loaded at loadInterfaceFiles()
            assert(!(configName in configDefinitionsBuiltIn))
            await loadValueFile(interfaceFile, configName, userRootDir)
          })
        )

        const configValueSources: ConfigValueSources = {}
        objectEntries(configDefinitionsRelevant)
          .filter(([configName]) => !isGlobalConfig(configName))
          .forEach(([configName, configDef]) => {
            const sources = resolveConfigValueSources(configName, configDef, interfaceFilesRelevant, userRootDir)
            if (!sources) return
            configValueSources[configName] = sources
          })

        const { routeFilesystem, isErrorPage } = determineRouteFilesystem(locationId, configValueSources)

        const pageConfig: PageConfigBuildTime = {
          pageId: locationId,
          isErrorPage,
          routeFilesystem,
          configValueSources,
          configValues: getConfigValues(configValueSources, configDefinitionsRelevant)
        }

        applyEffectsAll(pageConfig, configDefinitionsRelevant)
        pageConfig.configValues = getConfigValues(configValueSources, configDefinitionsRelevant)

        applyComputed(pageConfig, configDefinitionsRelevant)
        pageConfig.configValues = getConfigValues(configValueSources, configDefinitionsRelevant)

        return pageConfig
      })
  )

  // Show error message upon unknown config
  Object.entries(interfaceFilesByLocationId).forEach(([locationId, interfaceFiles]) => {
    const interfaceFilesRelevant = getInterfaceFilesRelevant(interfaceFilesByLocationId, locationId)
    const configDefinitionsRelevant = getConfigDefinitions(interfaceFilesRelevant)
    interfaceFiles.forEach((interfaceFile) => {
      Object.keys(interfaceFile.configMap).forEach((configName) => {
        assertConfigExists(
          configName,
          Object.keys(configDefinitionsRelevant),
          getFilePathToShowToUser(interfaceFile.filePath)
        )
      })
    })
  })
  return { pageConfigs, pageConfigGlobal, globalVikeConfig }
}

function interfacefileIsAlreaydLoaded(interfaceFile: InterfaceFile): boolean {
  const configMapValues = Object.values(interfaceFile.configMap)
  const isAlreadyLoaded = configMapValues.some((conf) => 'configValue' in conf)
  if (isAlreadyLoaded) {
    assert(configMapValues.every((conf) => 'configValue' in conf))
  }
  return isAlreadyLoaded
}

function getInterfaceFilesRelevant(
  interfaceFilesByLocationId: InterfaceFilesByLocationId,
  locationIdPage: string
): InterfaceFilesByLocationId {
  const interfaceFilesRelevant = Object.fromEntries(
    Object.entries(interfaceFilesByLocationId)
      .filter(([locationId]) => {
        return isInherited(locationId, locationIdPage)
      })
      .sort(([locationId1], [locationId2]) => sortAfterInheritanceOrder(locationId1, locationId2, locationIdPage))
  )
  return interfaceFilesRelevant
}

function getInterfaceFileList(interfaceFilesByLocationId: InterfaceFilesByLocationId): InterfaceFile[] {
  const interfaceFiles: InterfaceFile[] = []
  Object.values(interfaceFilesByLocationId).forEach((interfaceFiles_) => {
    interfaceFiles.push(...interfaceFiles_)
  })
  return interfaceFiles
}

function getGlobalConfigs(interfaceFilesByLocationId: InterfaceFilesByLocationId, userRootDir: string) {
  const locationIds = Object.keys(interfaceFilesByLocationId)
  const interfaceFilesGlobal = Object.fromEntries(
    Object.entries(interfaceFilesByLocationId).filter(([locationId]) => {
      return isGlobalLocation(locationId, locationIds)
    })
  )

  // Validate that global configs live in global interface files
  {
    const interfaceFilesGlobalPaths: string[] = []
    Object.entries(interfaceFilesGlobal).forEach(([locationId, interfaceFiles]) => {
      assert(isGlobalLocation(locationId, locationIds))
      interfaceFiles.forEach(({ filePath: { filePathRelativeToUserRootDir } }) => {
        if (filePathRelativeToUserRootDir) {
          interfaceFilesGlobalPaths.push(filePathRelativeToUserRootDir)
        }
      })
    })
    const globalPaths = Array.from(new Set(interfaceFilesGlobalPaths.map((p) => path.posix.dirname(p))))
    Object.entries(interfaceFilesByLocationId).forEach(([locationId, interfaceFiles]) => {
      interfaceFiles.forEach((interfaceFile) => {
        Object.keys(interfaceFile.configMap).forEach((configName) => {
          if (!isGlobalLocation(locationId, locationIds) && isGlobalConfig(configName)) {
            assertUsage(
              false,
              [
                `${getFilePathToShowToUser(interfaceFile.filePath)} defines the config ${pc.cyan(
                  configName
                )} which is global:`,
                globalPaths.length
                  ? `define ${pc.cyan(configName)} in ${joinEnglish(globalPaths, 'or')} instead`
                  : `create a global config (e.g. /pages/+config.js) and define ${pc.cyan(configName)} there instead`
              ].join(' ')
            )
          }
        })
      })
    })
  }

  const globalVikeConfig: Record<string, unknown> = {}
  const pageConfigGlobal: PageConfigGlobalBuildTime = {
    configValueSources: {}
  }
  objectEntries(configDefinitionsBuiltInGlobal).forEach(([configName, configDef]) => {
    const sources = resolveConfigValueSources(configName, configDef, interfaceFilesGlobal, userRootDir)
    const configValueSource = sources?.[0]
    if (!configValueSource) return
    if (configName === 'onBeforeRoute' || configName === 'onPrerenderStart') {
      assert(!('value' in configValueSource))
      pageConfigGlobal.configValueSources[configName] = [configValueSource]
    } else {
      assert('value' in configValueSource)
      if (configName === 'prerender' && typeof configValueSource.value === 'boolean') return
      assert(!configValueSource.isComputed)
      const sourceFilePath = getDefinedAtFilePathToShowToUser(configValueSource.definedAtInfo)
      assert(sourceFilePath)
      assertWarning(
        false,
        `Being able to define config ${pc.cyan(
          configName
        )} in ${sourceFilePath} is experimental and will likely be removed. Define the config ${pc.cyan(
          configName
        )} in Vike's Vite plugin options instead.`,
        { onlyOnce: true }
      )
      globalVikeConfig[configName] = configValueSource.value
    }
  })

  return { pageConfigGlobal, globalVikeConfig }
}

function resolveConfigValueSources(
  configName: string,
  configDef: ConfigDefinitionInternal,
  interfaceFilesRelevant: InterfaceFilesByLocationId,
  userRootDir: string
): null | ConfigValueSource[] {
  let sources: ConfigValueSource[] | null = null

  // interfaceFilesRelevant is sorted by sortAfterInheritanceOrder()
  for (const interfaceFiles of Object.values(interfaceFilesRelevant)) {
    const interfaceFilesDefiningConfig = interfaceFiles.filter((interfaceFile) => interfaceFile.configMap[configName])
    if (interfaceFilesDefiningConfig.length === 0) continue
    sources = sources ?? []
    const visited = new WeakSet<InterfaceFile>()
    const add = (interfaceFile: InterfaceFile) => {
      assert(!visited.has(interfaceFile))
      visited.add(interfaceFile)
      const configValueSource = getConfigValueSource(configName, interfaceFile, configDef, userRootDir)
      sources!.push(configValueSource)
    }

    // Main resolution logic
    {
      const interfaceValueFiles = interfaceFilesDefiningConfig
        .filter(
          (interfaceFile) =>
            interfaceFile.isValueFile &&
            // We consider side-effect configs (e.g. `export { frontmatter }` of .mdx files) later (i.e. with less priority)
            interfaceFile.configName === configName
        )
        .sort(makeOrderDeterministic)
      const interfaceConfigFiles = interfaceFilesDefiningConfig
        .filter(
          (interfaceFile) =>
            interfaceFile.isConfigFile &&
            // We consider value from extended configs (e.g. vike-react) later (i.e. with less priority)
            !interfaceFile.isConfigExtend
        )
        .sort(makeOrderDeterministic)
      const interfaceValueFile = interfaceValueFiles[0]
      const interfaceConfigFile = interfaceConfigFiles[0]
      // Make this value:
      //   /pages/some-page/+{configName}.js > `export default`
      // override that value:
      //   /pages/some-page/+config.h.js > `export default { someConfig }`
      const interfaceFileWinner = interfaceValueFile ?? interfaceConfigFile
      if (interfaceFileWinner) {
        const interfaceFilesOverriden = [...interfaceValueFiles, ...interfaceConfigFiles].filter(
          (f) => f !== interfaceFileWinner
        )
        // A user-land conflict of interfaceFiles with the same locationId means that the user has superfluously defined the config twice; the user should remove such redundancy making things unnecessarily ambiguous
        warnOverridenConfigValues(interfaceFileWinner, interfaceFilesOverriden, configName, configDef, userRootDir)
        ;[interfaceFileWinner, ...interfaceFilesOverriden].forEach((interfaceFile) => {
          add(interfaceFile)
        })
      }
    }

    // Side-effect configs such as `export { frontmatter }` in .mdx files
    interfaceFilesDefiningConfig
      .filter(
        (interfaceFile) =>
          interfaceFile.isValueFile &&
          // Is side-effect config
          interfaceFile.configName !== configName
      )
      .forEach((interfaceValueFileSideEffect) => {
        add(interfaceValueFileSideEffect)
      })

    // extends
    interfaceFilesDefiningConfig
      .filter((interfaceFile) => interfaceFile.isConfigFile && interfaceFile.isConfigExtend)
      // extended config files are already sorted by inheritance order
      .forEach((interfaceFile) => {
        add(interfaceFile)
      })

    interfaceFilesDefiningConfig.forEach((interfaceFile) => {
      assert(visited.has(interfaceFile))
    })
  }

  assert(sources === null || sources.length > 0)
  return sources
}
function makeOrderDeterministic(interfaceFile1: InterfaceFile, interfaceFile2: InterfaceFile): 0 | -1 | 1 {
  return lowerFirst<InterfaceFile>((interfaceFile) => {
    const { filePathRelativeToUserRootDir } = interfaceFile.filePath
    assert(isInterfaceFileUserLand(interfaceFile))
    assert(filePathRelativeToUserRootDir)
    return filePathRelativeToUserRootDir.length
  })(interfaceFile1, interfaceFile2)
}
function warnOverridenConfigValues(
  interfaceFileWinner: InterfaceFile,
  interfaceFilesOverriden: InterfaceFile[],
  configName: string,
  configDef: ConfigDefinitionInternal,
  userRootDir: string
) {
  interfaceFilesOverriden.forEach((interfaceFileLoser) => {
    const configValueSourceWinner = getConfigValueSource(configName, interfaceFileWinner, configDef, userRootDir)
    const configValueSourceLoser = getConfigValueSource(configName, interfaceFileLoser, configDef, userRootDir)
    assert(!configValueSourceLoser.isComputed)
    assert(!configValueSourceWinner.isComputed)
    assertWarning(
      false,
      `${getConfigSourceDefinedAtString(
        configName,
        configValueSourceLoser,
        undefined,
        true
      )} overriden by another ${getConfigSourceDefinedAtString(
        configName,
        configValueSourceWinner,
        undefined,
        false
      )}, remove one of the two`,
      { onlyOnce: false }
    )
  })
}

function isInterfaceFileUserLand(interfaceFile: InterfaceFile) {
  return (interfaceFile.isConfigFile && !interfaceFile.isConfigExtend) || interfaceFile.isValueFile
}

function getConfigValueSource(
  configName: string,
  interfaceFile: InterfaceFile,
  configDef: ConfigDefinitionInternal,
  userRootDir: string
): ConfigValueSource {
  const conf = interfaceFile.configMap[configName]
  assert(conf)
  const configEnv = configDef.env

  const definedAtConfigFile: DefinedAtFileInfo = {
    ...interfaceFile.filePath,
    fileExportPath: ['default', configName]
  }

  if (configDef._valueIsFilePath) {
    let definedAtInfo: DefinedAtFileInfo
    let valueFilePath: string
    if (interfaceFile.isConfigFile) {
      const { configValue } = conf
      const import_ = resolveImport(configValue, interfaceFile.filePath, userRootDir, configEnv, configName)
      const configDefinedAt = getConfigSourceDefinedAtString(configName, { definedAtInfo: definedAtConfigFile })
      assertUsage(import_, `${configDefinedAt} should be an import`)
      valueFilePath = import_.filePathRelativeToUserRootDir ?? import_.importPathAbsolute
      definedAtInfo = import_
    } else {
      assert(interfaceFile.isValueFile)
      valueFilePath = interfaceFile.filePath.filePathRelativeToUserRootDir
      definedAtInfo = {
        ...interfaceFile.filePath,
        fileExportPath: []
      }
    }
    const configValueSource: ConfigValueSource = {
      value: valueFilePath,
      valueIsFilePath: true,
      configEnv,
      valueIsImportedAtRuntime: true,
      isComputed: false,
      definedAtInfo
    }
    return configValueSource
  }

  if (interfaceFile.isConfigFile) {
    assert('configValue' in conf)
    const { configValue } = conf
    const import_ = resolveImport(configValue, interfaceFile.filePath, userRootDir, configEnv, configName)
    if (import_) {
      const configValueSource: ConfigValueSource = {
        configEnv,
        valueIsImportedAtRuntime: true,
        isComputed: false,
        definedAtInfo: import_
      }
      return configValueSource
    } else {
      const configValueSource: ConfigValueSource = {
        value: configValue,
        configEnv,
        valueIsImportedAtRuntime: false,
        isComputed: false,
        definedAtInfo: definedAtConfigFile
      }
      return configValueSource
    }
  } else if (interfaceFile.isValueFile) {
    const valueAlreadyLoaded = 'configValue' in conf
    const configValueSource: ConfigValueSource = {
      configEnv,
      valueIsImportedAtRuntime: !valueAlreadyLoaded,
      isComputed: false,
      definedAtInfo: {
        ...interfaceFile.filePath,
        fileExportPath:
          configName === interfaceFile.configName
            ? []
            : // Side-effect config (e.g. `export { frontmatter }` of .md files)
              [configName]
      }
    }
    if (valueAlreadyLoaded) {
      configValueSource.value = conf.configValue
    } else {
      assert(configEnv !== 'config-only')
    }
    return configValueSource
  }
  assert(false)
}

function assertFileEnv(filePathForEnvCheck: string, configEnv: ConfigEnvInternal, configName: string) {
  assertPosixPath(filePathForEnvCheck)
  if (!filesEnv.has(filePathForEnvCheck)) {
    filesEnv.set(filePathForEnvCheck, [])
  }
  const fileEnv = filesEnv.get(filePathForEnvCheck)!
  fileEnv.push({ configEnv, configName })
  const configDifferentEnv = fileEnv.filter((c) => c.configEnv !== configEnv)[0]
  if (configDifferentEnv) {
    assertUsage(
      false,
      [
        `${filePathForEnvCheck} defines the value of configs living in different environments:`,
        ...[configDifferentEnv, { configName, configEnv }].map(
          (c) => `  - config ${pc.cyan(c.configName)} which value lives in environment ${pc.cyan(c.configEnv)}`
        ),
        'Defining config values in the same file is allowed only if they live in the same environment, see https://vike.dev/header-file/import-from-same-file'
      ].join('\n')
    )
  }
}

function isDefiningPage(interfaceFiles: InterfaceFile[]): boolean {
  for (const interfaceFile of interfaceFiles) {
    const configNames = Object.keys(interfaceFile.configMap)
    if (configNames.some((configName) => isDefiningPageConfig(configName))) {
      return true
    }
  }
  return false
}
function isDefiningPageConfig(configName: string): boolean {
  return ['Page', 'route'].includes(configName)
}

function resolveImport(
  configValue: unknown,
  importerFilePath: FilePath,
  userRootDir: string,
  configEnv: ConfigEnvInternal,
  configName: string
) {
  if (typeof configValue !== 'string') return null
  const importData = parseImportData(configValue)
  if (!importData) return null

  const { importPath, exportName } = importData
  const filePathAbsolute = resolveImportPath(importData, importerFilePath)

  assertFileEnv(filePathAbsolute ?? importPath, configEnv, configName)

  const fileExportPath = exportName === 'default' || exportName === configName ? [] : [exportName]

  if (importPath.startsWith('.')) {
    // We need to resolve relative paths into absolute paths. Because the import paths are included in virtual files:
    // ```
    // [vite] Internal server error: Failed to resolve import "./onPageTransitionHooks" from "virtual:vike:pageConfigValuesAll:client:/pages/index". Does the file exist?
    // ```
    assertImportPath(filePathAbsolute, importData, importerFilePath)
    const filePathRelativeToUserRootDir = resolveImportPath_relativeToUserRootDir(
      filePathAbsolute,
      importData,
      importerFilePath,
      userRootDir
    )
    return {
      exportName,
      fileExportPath,
      filePathAbsolute,
      filePathRelativeToUserRootDir,
      importPathAbsolute: null
    }
  } else {
    // importPath can be:
    //  - an npm package import
    //  - a path alias
    return {
      exportName,
      fileExportPath,
      filePathAbsolute,
      filePathRelativeToUserRootDir: null,
      importPathAbsolute: importPath
    }
  }
}

function resolveImportPath_relativeToUserRootDir(
  filePathAbsolute: string,
  importData: ImportData,
  configFilePath: FilePath,
  userRootDir: string
) {
  assertPosixPath(userRootDir)
  let filePathRelativeToUserRootDir: string
  if (filePathAbsolute.startsWith(userRootDir)) {
    filePathRelativeToUserRootDir = getVitePathFromAbsolutePath(filePathAbsolute, userRootDir)
  } else {
    assertUsage(
      false,
      `${getFilePathToShowToUser(configFilePath)} imports from a relative path ${pc.cyan(
        importData.importPath
      )} outside of ${userRootDir} which is forbidden: import from a relative path inside ${userRootDir}, or import from a dependency's package.json#exports entry instead`
    )
    // None of the following works. Seems to be a Vite bug?
    // /*
    // assert(filePathAbsolute.startsWith('/'))
    // filePath = `/@fs${filePathAbsolute}`
    // /*/
    // filePathRelativeToUserRootDir = path.posix.relative(userRootDir, filePathAbsolute)
    // assert(filePathRelativeToUserRootDir.startsWith('../'))
    // filePathRelativeToUserRootDir = '/' + filePathRelativeToUserRootDir
    // //*/
  }

  assertPosixPath(filePathRelativeToUserRootDir)
  assert(filePathRelativeToUserRootDir.startsWith('/'))
  return filePathRelativeToUserRootDir
}

function getVitePathFromAbsolutePath(filePathAbsolute: string, root: string): string {
  assertPosixPath(filePathAbsolute)
  assertPosixPath(root)
  assert(filePathAbsolute.startsWith(root))
  let vitePath = path.posix.relative(root, filePathAbsolute)
  assert(!vitePath.startsWith('/') && !vitePath.startsWith('.'))
  vitePath = '/' + vitePath
  return vitePath
}

function getConfigDefinitions(interfaceFilesRelevant: InterfaceFilesByLocationId): ConfigDefinitionsIncludingCustom {
  const configDefinitions: ConfigDefinitionsIncludingCustom = { ...configDefinitionsBuiltIn }
  Object.entries(interfaceFilesRelevant).forEach(([_locationId, interfaceFiles]) => {
    interfaceFiles.forEach((interfaceFile) => {
      const configMeta = interfaceFile.configMap['meta']
      if (!configMeta) return
      const meta = configMeta.configValue
      assertMetaValue(
        meta,
        // Maybe we should use the getConfigDefinedAtString() helper?
        `Config ${pc.cyan('meta')} defined at ${getFilePathToShowToUser(interfaceFile.filePath)}`
      )
      objectEntries(meta).forEach(([configName, configDefinition]) => {
        // User can override an existing config definition
        configDefinitions[configName] = {
          ...configDefinitions[configName],
          ...configDefinition
        }
      })
    })
  })
  return configDefinitions
}

function assertMetaValue(
  metaVal: unknown,
  configMetaDefinedAt: `Config meta${string}`
): asserts metaVal is Record<string, ConfigDefinitionInternal> {
  assertUsage(
    isObject(metaVal),
    `${configMetaDefinedAt} has an invalid type ${pc.cyan(typeof metaVal)}: it should be an object instead.`
  )
  objectEntries(metaVal).forEach(([configName, def]) => {
    assertUsage(
      isObject(def),
      `${configMetaDefinedAt} sets meta.${configName} to a value with an invalid type ${pc.cyan(
        typeof def
      )}: it should be an object instead.`
    )

    // env
    {
      const envValues: string[] = [
        'client-only',
        'server-only',
        'server-and-client',
        'config-only'
      ] satisfies ConfigEnv[]
      const hint = [
        `Set the value of ${pc.cyan('env')} to `,
        joinEnglish(
          envValues.map((s) => pc.cyan(`'${s}'`)),
          'or'
        ),
        '.'
      ].join('')
      assertUsage('env' in def, `${configMetaDefinedAt} doesn't set meta.${configName}.env but it's required. ${hint}`)
      assertUsage(
        hasProp(def, 'env', 'string'),
        `${configMetaDefinedAt} sets meta.${configName}.env to an invalid type ${pc.cyan(typeof def.env)}. ${hint}`
      )
      assertUsage(
        envValues.includes(def.env),
        `${configMetaDefinedAt} sets meta.${configName}.env to an invalid value ${pc.cyan(`'${def.env}'`)}. ${hint}`
      )
    }

    // effect
    if ('effect' in def) {
      assertUsage(
        hasProp(def, 'effect', 'function'),
        `${configMetaDefinedAt} sets meta.${configName}.effect to an invalid type ${pc.cyan(
          typeof def.effect
        )}: it should be a function instead`
      )
      assertUsage(
        def.env === 'config-only',
        `${configMetaDefinedAt} sets meta.${configName}.effect but it's only supported if meta.${configName}.env is ${pc.cyan(
          'config-only'
        )} (but it's ${pc.cyan(def.env)} instead)`
      )
    }
  })
}

function applyEffectsAll(pageConfig: PageConfigBuildTime, configDefinitionsRelevant: ConfigDefinitionsIncludingCustom) {
  objectEntries(configDefinitionsRelevant).forEach(([configName, configDef]) => {
    if (!configDef.effect) return
    // The value needs to be loaded at config time, that's why we only support effect for configs that are config-only for now.
    // (We could support effect for non config-only by always loading its value at config time, regardless of the config's `env` value.)
    assertWarning(
      configDef.env === 'config-only',
      [
        `Adding an effect to ${pc.cyan(configName)} may not work as expected because ${pc.cyan(
          configName
        )} has an ${pc.cyan('env')} that is different than ${pc.cyan('config-only')} (its env is ${pc.cyan(
          configDef.env
        )}).`,
        'Reach out to a maintainer if you want to use this in production.'
      ].join(' '),
      { onlyOnce: true }
    )
    const source = pageConfig.configValueSources[configName]?.[0]
    if (!source) return
    assert(!source.isComputed)
    const configModFromEffect = configDef.effect({
      configValue: source.value,
      configDefinedAt: getConfigSourceDefinedAtString(configName, source)
    })
    if (!configModFromEffect) return
    assert(hasProp(source, 'value')) // We need to assume that the config value is loaded at build-time
    applyEffect(configModFromEffect, source, pageConfig.configValueSources)
  })
}
function applyEffect(
  configModFromEffect: Config,
  configValueEffectSource: ConfigValueSource,
  configValueSources: ConfigValueSources
) {
  const notSupported = `config.meta[configName].effect currently only supports modifying the the ${pc.cyan(
    'env'
  )} of a config. Reach out to a maintainer if you need more capabilities.` as const
  objectEntries(configModFromEffect).forEach(([configName, configValue]) => {
    if (configName === 'meta') {
      assert(!configValueEffectSource.isComputed)
      assertMetaValue(configValue, getConfigSourceDefinedAtString(configName, configValueEffectSource, true))
      objectEntries(configValue).forEach(([configTargetName, configTargetDef]) => {
        {
          const keys = Object.keys(configTargetDef)
          assertUsage(keys.includes('env'), notSupported)
          assertUsage(keys.length === 1, notSupported)
        }
        const envOverriden = configTargetDef.env
        const sources = configValueSources[configTargetName]
        sources?.forEach((configValueSource) => {
          configValueSource.configEnv = envOverriden
        })
      })
    } else {
      assertUsage(false, notSupported)
      // If we do end implementing being able to set the value of a config:
      //  - For setting definedAtInfo: we could take the definedAtInfo of the effect config while appending '(effect)' to definedAtInfo.fileExportPath
    }
  })
}

function applyComputed(pageConfig: PageConfigBuildTime, configDefinitionsRelevant: ConfigDefinitionsIncludingCustom) {
  objectEntries(configDefinitionsRelevant).forEach(([configName, configDef]) => {
    if (!configDef._computed) return
    const value = configDef._computed(pageConfig)
    if (value === undefined) return

    const configValueSource: ConfigValueSource = {
      value,
      configEnv: configDef.env,
      definedAtInfo: null,
      isComputed: true,
      valueIsImportedAtRuntime: false
    }

    pageConfig.configValueSources[configName] ??= []
    // Computed values are inserted last: they have the least priority (i.e. computed can be overriden)
    pageConfig.configValueSources[configName]!.push(configValueSource)
  })
}

async function findPlusFiles(
  userRootDir: string,
  ignoreDirs: string[],
  isDev: boolean,
  extensions: ExtensionResolved[]
) {
  const timeBase = new Date().getTime()
  assertPosixPath(userRootDir)

  const ignorePatterns = []
  for (const dir of ignoreDirs) {
    assertPosixPath(dir)
    ignorePatterns.push(`${path.posix.relative(userRootDir, dir)}/**`)
  }
  const result = await glob(`**/+*.${scriptFileExtensions}`, {
    ignore: [
      '**/node_modules/**',
      // Allow:
      // ```
      // +Page.js
      // +Page.telefunc.js
      // ```
      '**/*.telefunc.*',
      ...ignorePatterns
    ],
    cwd: userRootDir,
    dot: false
  })
  const time = new Date().getTime() - timeBase
  if (isDev) {
    // We only warn in dev, because while building it's expected to take a long time as fast-glob is competing for resources with other tasks
    assertWarning(
      time < 2 * 1000,
      `Crawling your user files took an unexpected long time (${time}ms). Create a new issue on Vike's GitHub.`,
      {
        onlyOnce: 'slow-page-files-search'
      }
    )
  }

  const plusFiles = result.map((p) => {
    p = toPosixPath(p)
    const filePathRelativeToUserRootDir = path.posix.join('/', p)
    const filePathAbsolute = path.posix.join(userRootDir, p)
    return { filePathRelativeToUserRootDir, filePathAbsolute }
  })

  extensions.forEach((extension) => {
    extension.pageConfigsDistFiles?.forEach((pageConfigDistFile) => {
      // TODO/v1-release: remove
      if (!pageConfigDistFile.importPath.includes('+')) return
      assert(pageConfigDistFile.importPath.includes('+'))
      assert(path.posix.basename(pageConfigDistFile.importPath).startsWith('+'))
      const { importPath, filePath } = pageConfigDistFile
      plusFiles.push({
        filePathRelativeToUserRootDir: importPath,
        filePathAbsolute: filePath
      })
    })
  })

  return plusFiles
}

function getConfigName(filePath: string): string | null {
  assertPosixPath(filePath)
  if (isTmpFile(filePath)) return null
  const fileName = path.posix.basename(filePath)
  assertNoUnexpectedPlusSign(filePath, fileName)
  const basename = fileName.split('.')[0]!
  if (!basename.startsWith('+')) {
    return null
  } else {
    const configName = basename.slice(1)
    return configName
  }
}
function assertNoUnexpectedPlusSign(filePath: string, fileName: string) {
  const dirs = path.posix.dirname(filePath).split('/')
  dirs.forEach((dir, i) => {
    const dirPath = dirs.slice(0, i + 1).join('/')
    assertUsage(
      !dir.includes('+'),
      `Character '+' is a reserved character: remove '+' from the directory name ${dirPath}/`
    )
  })
  assertUsage(
    !fileName.slice(1).includes('+'),
    `Character '+' is only allowed at the beginning of filenames: make sure ${filePath} doesn't contain any '+' in its filename other than its first letter`
  )
}

type ConfigFile = {
  fileExports: Record<string, unknown>
  filePath: FilePath
  extendsFilePaths: string[]
}

async function loadConfigFile(
  configFilePath: FilePath,
  userRootDir: string,
  visited: string[]
): Promise<{ configFile: ConfigFile; extendsConfigs: ConfigFile[] }> {
  const { filePathAbsolute } = configFilePath
  assertNoInfiniteLoop(visited, filePathAbsolute)
  const { fileExports } = await transpileAndExecuteFile(configFilePath, false, userRootDir)
  const { extendsConfigs, extendsFilePaths } = await loadExtendsConfigs(fileExports, configFilePath, userRootDir, [
    ...visited,
    filePathAbsolute
  ])

  const configFile: ConfigFile = {
    fileExports,
    filePath: configFilePath,
    extendsFilePaths
  }
  return { configFile, extendsConfigs }
}
function assertNoInfiniteLoop(visited: string[], filePathAbsolute: string) {
  const idx = visited.indexOf(filePathAbsolute)
  if (idx === -1) return
  const loop = visited.slice(idx)
  assert(loop[0] === filePathAbsolute)
  assertUsage(idx === -1, `Infinite extends loop ${[...loop, filePathAbsolute].join('>')}`)
}

async function loadExtendsConfigs(
  configFileExports: Record<string, unknown>,
  configFilePath: FilePath,
  userRootDir: string,
  visited: string[]
) {
  const extendsImportData = getExtendsImportData(configFileExports, configFilePath)
  const extendsConfigFiles: FilePath[] = []
  extendsImportData.map((importData) => {
    const { importPath: importPath } = importData
    // TODO
    //  - validate extends configs
    const filePathAbsolute = resolveImportPath(importData, configFilePath)
    assertImportPath(filePathAbsolute, importData, configFilePath)
    assertExtendsImportPath(importPath, filePathAbsolute, configFilePath)
    // - filePathRelativeToUserRootDir has no functionality beyond nicer error messages for user
    // - Using importPath would be visually nicer but it's ambigous => we rather pick filePathAbsolute for added clarity
    const filePathRelativeToUserRootDir = determineFilePathRelativeToUserDir(filePathAbsolute, userRootDir)
    extendsConfigFiles.push({
      filePathAbsolute,
      // TODO: fix type cast
      filePathRelativeToUserRootDir: filePathRelativeToUserRootDir as null,
      importPathAbsolute: importPath
    })
  })

  const extendsConfigs: ConfigFile[] = []
  await Promise.all(
    extendsConfigFiles.map(async (configFilePath) => {
      const result = await loadConfigFile(configFilePath, userRootDir, visited)
      extendsConfigs.push(result.configFile)
      extendsConfigs.push(...result.extendsConfigs)
    })
  )

  const extendsFilePaths = extendsConfigFiles.map((f) => f.filePathAbsolute)

  return { extendsConfigs, extendsFilePaths }
}

function determineFilePathRelativeToUserDir(filePathAbsolute: string, userRootDir: string): null | string {
  assertPosixPath(filePathAbsolute)
  assertPosixPath(userRootDir)
  if (!filePathAbsolute.startsWith(userRootDir)) {
    return null
  }
  let filePathRelativeToUserRootDir = filePathAbsolute.slice(userRootDir.length)
  if (!filePathRelativeToUserRootDir.startsWith('/'))
    filePathRelativeToUserRootDir = '/' + filePathRelativeToUserRootDir
  return filePathRelativeToUserRootDir
}

function assertExtendsImportPath(importPath: string, filePath: string, configFilePath: FilePath) {
  if (isNpmPackageImport(importPath)) {
    const fileDir = path.posix.dirname(filePath) + '/'
    const fileName = path.posix.basename(filePath)
    const fileNameBaseCorrect = '+config'
    const [fileNameBase, ...fileNameRest] = fileName.split('.')
    const fileNameCorrect = [fileNameBaseCorrect, ...fileNameRest].join('.')
    assertWarning(fileNameBase === fileNameBaseCorrect, `Rename ${fileName} to ${fileNameCorrect} in ${fileDir}`, {
      onlyOnce: true
    })
  } else {
    assertWarning(
      false,
      `${getFilePathToShowToUser(configFilePath)} uses ${pc.cyan('extends')} to inherit from ${pc.cyan(
        importPath
      )} which is a user-land file: this is experimental and may be remove at any time. Reach out to a maintainer if you need this feature.`,
      { onlyOnce: true }
    )
  }
}

function getExtendsImportData(configFileExports: Record<string, unknown>, configFilePath: FilePath): ImportData[] {
  const filePathToShowToUser = getFilePathToShowToUser(configFilePath)
  assertExportsOfConfigFile(configFileExports, filePathToShowToUser)
  const defaultExports = configFileExports.default
  const wrongUsage = `${filePathToShowToUser} sets the config 'extends' to an invalid value, see https://vike.dev/extends`
  let extendList: string[]
  if (!('extends' in defaultExports)) {
    return []
  } else if (hasProp(defaultExports, 'extends', 'string')) {
    extendList = [defaultExports.extends]
  } else if (hasProp(defaultExports, 'extends', 'string[]')) {
    extendList = defaultExports.extends
  } else {
    assertUsage(false, wrongUsage)
  }
  const extendsImportData = extendList.map((importDataSerialized) => {
    const importData = parseImportData(importDataSerialized)
    assertUsage(importData, wrongUsage)
    return importData
  })
  return extendsImportData
}

type UserFilePath = {
  filePathAbsolute: string
  filePathRelativeToUserRootDir: string
}

// TODO: re-use this
function handleUserFileError(err: unknown, isDev: boolean) {
  // Properly handle error during transpilation so that we can use assertUsage() during transpilation
  if (isDev) {
    throw err
  } else {
    // Avoid ugly error format:
    // ```
    // [vike:importUserCode] Could not load virtual:vike:importUserCode:server: [vike@0.4.70][Wrong Usage] /pages/+config.ts sets the config 'onRenderHtml' to the value './+config/onRenderHtml-i-dont-exist.js' but no file was found at /home/rom/code/vike/examples/v1/pages/+config/onRenderHtml-i-dont-exist.js
    // Error: [vike@0.4.70][Wrong Usage] /pages/+config.ts sets the config 'onRenderHtml' to the value './+config/onRenderHtml-i-dont-exist.js' but no file was found at /home/rom/code/vike/examples/v1/pages/+config/onRenderHtml-i-dont-exist.js
    //     at ...
    //     at ...
    //     at ...
    //     at ...
    //     at ...
    //     at ...
    //   code: 'PLUGIN_ERROR',
    //   plugin: 'vike:importUserCode',
    //   hook: 'load',
    //   watchFiles: [
    //     '/home/rom/code/vike/vike/dist/esm/node/importBuild.js',
    //     '\x00virtual:vike:importUserCode:server'
    //   ]
    // }
    //  ELIFECYCLE  Command failed with exit code 1.
    // ```
    console.log('')
    console.error(err)
    process.exit(1)
  }
}

function isGlobalConfig(configName: string): configName is ConfigNameGlobal {
  if (configName === 'prerender') return false
  const configNamesGlobal = getConfigNamesGlobal()
  return arrayIncludes(configNamesGlobal, configName)
}
function getConfigNamesGlobal() {
  return Object.keys(configDefinitionsBuiltInGlobal)
}

function assertConfigExists(configName: string, configNamesRelevant: string[], definedByFile: string) {
  const configNames = [...configNamesRelevant, ...getConfigNamesGlobal()]
  if (configNames.includes(configName)) return
  handleUnknownConfig(configName, configNames, definedByFile)
  assert(false)
}
function handleUnknownConfig(configName: string, configNames: string[], definedByFile: string) {
  let errMsg = `${definedByFile} defines an unknown config ${pc.cyan(configName)}`
  let configNameSimilar: string | null = null
  if (configName === 'page') {
    configNameSimilar = 'Page'
  } else {
    configNameSimilar = getMostSimilar(configName, configNames)
  }
  if (configNameSimilar || configName === 'page') {
    assert(configNameSimilar)
    assert(configNameSimilar !== configName)
    errMsg += `, did you mean to define ${pc.cyan(configNameSimilar)} instead?`
    if (configName === 'page') {
      errMsg += ` (The name of the config ${pc.cyan('Page')} starts with a capital letter ${pc.cyan(
        'P'
      )} because it usually defines a UI component: a ubiquitous JavaScript convention is to start the name of UI components with a capital letter.)`
    }
  } else {
    errMsg += `, you need to define the config ${pc.cyan(configName)} by using ${pc.cyan(
      'config.meta'
    )} https://vike.dev/meta`
  }
  assertUsage(false, errMsg)
}

function determineRouteFilesystem(locationId: string, configValueSources: ConfigValueSources) {
  const configName = 'filesystemRoutingRoot'
  const configFilesystemRoutingRoot = configValueSources[configName]?.[0]
  let filesystemRouteString = getFilesystemRouteString(locationId)
  if (determineIsErrorPage(filesystemRouteString)) {
    return { isErrorPage: true as const, routeFilesystem: undefined }
  }
  let filesystemRouteDefinedBy = getFilesystemRouteDefinedBy(locationId) // for log404()
  if (configFilesystemRoutingRoot) {
    const routingRoot = getFilesystemRoutingRootEffect(configFilesystemRoutingRoot, configName)
    if (routingRoot) {
      const { filesystemRoutingRootEffect, filesystemRoutingRootDefinedAt } = routingRoot
      const debugInfo = { locationId, routeFilesystem: filesystemRouteString, configFilesystemRoutingRoot }
      assert(filesystemRouteString.startsWith(filesystemRoutingRootEffect.before), debugInfo)
      filesystemRouteString = applyFilesystemRoutingRootEffect(filesystemRouteString, filesystemRoutingRootEffect)
      filesystemRouteDefinedBy = `${filesystemRouteDefinedBy} (with ${filesystemRoutingRootDefinedAt})`
    }
  }
  assert(filesystemRouteString.startsWith('/'))
  const routeFilesystem = {
    routeString: filesystemRouteString,
    definedBy: filesystemRouteDefinedBy
  }
  return { routeFilesystem, isErrorPage: undefined }
}
function getFilesystemRoutingRootEffect(
  configFilesystemRoutingRoot: ConfigValueSource,
  configName: 'filesystemRoutingRoot'
) {
  assert(configFilesystemRoutingRoot.configEnv === 'config-only')
  // Eagerly loaded since it's config-only
  assert('value' in configFilesystemRoutingRoot)
  const { value } = configFilesystemRoutingRoot
  assert(!configFilesystemRoutingRoot.isComputed)
  const configDefinedAt = getConfigSourceDefinedAtString(configName, configFilesystemRoutingRoot)
  assertUsage(typeof value === 'string', `${configDefinedAt} should be a string`)
  assertUsage(
    value.startsWith('/'),
    `${configDefinedAt} is ${pc.cyan(value)} but it should start with a leading slash ${pc.cyan('/')}`
  )
  assert(!configFilesystemRoutingRoot.isComputed)
  const { filePathRelativeToUserRootDir } = configFilesystemRoutingRoot.definedAtInfo
  assert(filePathRelativeToUserRootDir)
  const before = getFilesystemRouteString(getLocationId(filePathRelativeToUserRootDir))
  const after = value
  const filesystemRoutingRootEffect = { before, after }
  return { filesystemRoutingRootEffect, filesystemRoutingRootDefinedAt: configDefinedAt }
}
function determineIsErrorPage(routeFilesystem: string) {
  assertPosixPath(routeFilesystem)
  return routeFilesystem.split('/').includes('_error')
}

function resolveImportPath(importData: ImportData, importerFilePath: FilePath): string | null {
  const importerFilePathAbsolute = importerFilePath.filePathAbsolute
  assertPosixPath(importerFilePathAbsolute)
  const cwd = path.posix.dirname(importerFilePathAbsolute)
  // filePathAbsolute is expected to be null when importData.importPath is a Vite path alias
  const filePathAbsolute = requireResolve(importData.importPath, cwd)
  return filePathAbsolute
}
function assertImportPath(
  filePathAbsolute: string | null,
  importData: ImportData,
  importerFilePath: FilePath
): asserts filePathAbsolute is string {
  const { importPath: importPath, importStringWasGenerated, importString } = importData
  const filePathToShowToUser = getFilePathToShowToUser(importerFilePath)

  if (!filePathAbsolute) {
    const importPathString = pc.cyan(`'${importPath}'`)
    const errIntro = importStringWasGenerated
      ? (`The import path ${importPathString} in ${filePathToShowToUser}` as const)
      : (`The import ${pc.cyan(importString)} defined in ${filePathToShowToUser}` as const)
    const errIntro2 = `${errIntro} couldn't be resolved: does ${importPathString}` as const
    if (importPath.startsWith('.')) {
      assertUsage(false, `${errIntro2} point to an existing file?`)
    } else {
      assertUsage(false, `${errIntro2} exist?`)
    }
  }
}

function isVikeConfigFile(filePath: string): boolean {
  return !!getConfigName(filePath)
}

function getConfigValues(
  configValueSources: ConfigValueSources,
  configDefinitionsRelevant: ConfigDefinitionsIncludingCustom
): ConfigValues {
  const configValues: ConfigValues = {}
  Object.entries(configValueSources).forEach(([configName, sources]) => {
    const configDef = configDefinitionsRelevant[configName]
    assert(configDef)
    if (!configDef.cumulative) {
      const configValueSource = sources[0]!
      if ('value' in configValueSource) {
        const { value } = configValueSource
        const definedAt = configValueSource.isComputed ? { isComputed: true as const } : getDefinedAt(configValueSource)
        configValues[configName] = {
          value,
          definedAt
        }
      }
    } else {
      const value = mergeCumulative(configName, sources)
      configValues[configName] = {
        value,
        definedAt: {
          isCumulative: true,
          files: sources.map((source) => getDefinedAtFile(source))
        }
      }
    }
  })
  return configValues
}

function mergeCumulative(configName: string, configValueSources: ConfigValueSource[]): unknown[] | Set<unknown> {
  const valuesArr: unknown[][] = []
  const valuesSet: Set<unknown>[] = []
  let configValueSourcePrevious: ConfigValueSource | null = null
  configValueSources.forEach((configValueSource) => {
    assert(!configValueSource.isComputed)
    const configDefinedAt = getConfigSourceDefinedAtString(configName, configValueSource)
    const configNameColored = pc.cyan(configName)
    // We could, in principle, also support cumulative values to be defined in +${configName}.js but it ins't completely trivial to implement
    assertUsage(
      'value' in configValueSource,
      `${configDefinedAt} is only allowed to be defined in a +config.h.js file. (Because the values of ${configNameColored} are cumulative.)`
    )
    /* This is more confusing than adding value. For example, this explanation shouldn't be shown for the passToClient config.
    const explanation = `(Because the values of ${configNameColored} are cumulative and therefore merged together.)` as const
    */

    // Make sure configValueSource.value is serializable
    getConfigValueSerialized(configValueSource.value, configName, getDefinedAt(configValueSource))

    const assertNoMixing = (isSet: boolean) => {
      type T = 'a Set' | 'an array'
      const vals1 = isSet ? valuesSet : valuesArr
      const t1: T = isSet ? 'a Set' : 'an array'
      const vals2 = !isSet ? valuesSet : valuesArr
      const t2: T = !isSet ? 'a Set' : 'an array'
      assert(vals1.length > 0)
      if (vals2.length === 0) return
      assert(configValueSourcePrevious)
      assert(!configValueSourcePrevious.isComputed)
      const configPreviousDefinedAt = getConfigSourceDefinedAtString(
        configName,
        configValueSourcePrevious,
        undefined,
        false
      )
      assertUsage(
        false,
        `${configDefinedAt} sets ${t1} but another ${configPreviousDefinedAt} sets ${t2} which is forbidden: the values must be all arrays or all sets (you cannot mix).`
      )
    }

    const { value } = configValueSource
    if (Array.isArray(value)) {
      valuesArr.push(value)
      assertNoMixing(false)
    } else if (value instanceof Set) {
      valuesSet.push(value)
      assertNoMixing(true)
    } else {
      assertUsage(false, `${configDefinedAt} must be an array or a Set`)
    }

    configValueSourcePrevious = configValueSource
  })

  if (valuesArr.length > 0) {
    assert(valuesSet.length === 0)
    const result = mergeCumulativeValues(valuesArr)
    assert(result !== null)
    return result
  }
  if (valuesSet.length > 0) {
    assert(valuesArr.length === 0)
    const result = mergeCumulativeValues(valuesSet)
    assert(result !== null)
    return result
  }
  assert(false)
}

// TODO: rename
// TODO: refactor
function getConfigSourceDefinedAtString<T extends string>(
  configName: T,
  { definedAtInfo }: { definedAtInfo: DefinedAtFileInfo },
  isEffect: true | undefined = undefined,
  sentenceBegin = true
) {
  return getConfigDefinedAtString(
    configName,
    {
      definedAt: {
        isEffect,
        file: {
          filePathToShowToUser: getDefinedAtFilePathToShowToUser(definedAtInfo),
          fileExportPath: definedAtInfo.fileExportPath
        }
      }
    },
    sentenceBegin as true
  )
}

function getDefinedAtFilePathToShowToUser(definedAtInfo: DefinedAtFileInfo): string {
  return definedAtInfo.filePathRelativeToUserRootDir ?? definedAtInfo.importPathAbsolute
}
function getDefinedAtFile(source: ConfigValueSource): DefinedAtFile {
  assert(!source.isComputed)
  return {
    filePathToShowToUser: getDefinedAtFilePathToShowToUser(source.definedAtInfo),
    fileExportPath: source.definedAtInfo.fileExportPath
  }
}
function getDefinedAt(configValueSource: ConfigValueSource): DefinedAt {
  return {
    file: getDefinedAtFile(configValueSource)
  }
}
