export { analyzePage }

import type { ClientDependency } from '../../../shared/getPageFiles/analyzePageClientSide/ClientDependency.js'
import { getVikeClientEntry } from '../../../shared/getPageFiles/analyzePageClientSide/determineClientEntry.js'
import type { PageFile } from '../../../shared/getPageFiles/getPageFileObject.js'
import type { PageConfigRuntime } from '../../../shared/page-configs/PageConfig.js'
import { type AnalysisResult, analyzePageClientSide } from '../../../shared/getPageFiles/analyzePageClientSide.js'
import { getVirtualFileIdPageConfigValuesAll } from '../../shared/virtual-files/virtualFilePageConfigValuesAll.js'
import { analyzeClientSide } from '../../../shared/getPageFiles/analyzeClientSide.js'
import { getGlobalContext } from '../globalContext.js'
import { getClientEntryFilePath } from '../../shared/getClientEntryFilePath.js'

function analyzePage(pageFilesAll: PageFile[], pageConfig: null | PageConfigRuntime, pageId: string): AnalysisResult {
  if (pageConfig) {
    const { isClientSideRenderable, isClientRouting } = analyzeClientSide(pageConfig, pageFilesAll, pageId)
    const clientDependencies: ClientDependency[] = []
    clientDependencies.push({
      id: getVirtualFileIdPageConfigValuesAll(pageConfig.pageId, true),
      onlyAssets: false,
      eagerlyImported: false
    })
    // In production we inject the import of the server virtual module with ?extractAssets inside the client virtual module
    if (!getGlobalContext().isProduction) {
      clientDependencies.push({
        id: getVirtualFileIdPageConfigValuesAll(pageConfig.pageId, false),
        onlyAssets: true,
        eagerlyImported: false
      })
    }
    /* Remove?
    Object.values(pageConfig.configElements).forEach((configElement) => {
      if (configElement.importPath) {
        const { env } = configElement
        assert(env)
        const onlyAssets = env === 'server-only'
        const eagerlyImported = env === '_routing-eager'
        if (onlyAssets || eagerlyImported) {
          clientDependencies.push({
            id: configElement.importPath,
            onlyAssets,
            eagerlyImported
          })
        }
      }
    })
    */

    const clientEntries: string[] = []
    {
      const entries: string[] = []
      if (isClientSideRenderable) {
        const clientEntryVike = getVikeClientEntry(isClientRouting)
        entries.push(clientEntryVike)
      }
      const clientEntryUser = getClientEntryFilePath(pageConfig)
      if (clientEntryUser) {
        entries.push(clientEntryUser)
      }
      entries.forEach((clientEntry) => {
        clientDependencies.push({
          id: clientEntry,
          onlyAssets: false,
          eagerlyImported: false
        })
        clientEntries.push(clientEntry)
      })
    }

    return {
      isHtmlOnly: !isClientSideRenderable,
      isClientRouting,
      clientEntries,
      clientDependencies,
      // pageFilesClientSide and pageFilesServerSide are only used for debugging
      pageFilesClientSide: [],
      pageFilesServerSide: []
    }
  } else {
    return analyzePageClientSide(pageFilesAll, pageId)
  }
}
