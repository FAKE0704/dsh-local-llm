// dsh-local-llm — Host 侧 Typert Remote 服务：设置页经官方 API 网关调用。
//
// 范本对照 dsh-fabric-memory/remote.js：TypertRemoteService 子类（构造即以
// serviceKey 注册 Cordis 服务并绑 typertRemote），typert.register(清单) 声明
// 端点（网关 claimsEndpoint 优先查 typert.local——不依赖 SRC 源码模式发现）。
// 方法语义全部委托 host-service.js 的 rpcInvoke（单一分发面，不复制逻辑）。

import { z } from 'zod'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

function strictCodec(typeSymbol, schema) {
  return { mode: 'strict', typeSymbol, create: () => schema }
}

/** 参数透传（looseObject 保留未知键——z.object 默认 strip 会把 {id:…} 削成 {}）；
 * 入参的精确校验由 core.js 的 parse*Input 完成（单一真源） */
const anyObject = z.union([z.looseObject({}), z.undefined()])

const result = strictCodec('dsh-local-llm#RpcResult', z.any())

function endpoint(method, hasParams = true) {
  return {
    id: `dsh-local-llm#localLlm/${method}`,
    service: 'localLlm',
    namespace: 'localLlm',
    method,
    invocation: { kind: 'direct' },
    parameters: hasParams
      ? [{ name: 'params', wire: 'params', source: 'json', codec: strictCodec(`dsh-local-llm#${method}Params`, anyObject) }]
      : [],
    result,
  }
}

export const LOCAL_LLM_MANIFEST = {
  package: 'dsh-local-llm',
  face: 'host',
  schemas: [],
  invocations: [
    endpoint('list', false),
    endpoint('preview'),
    endpoint('pull'),
    endpoint('deploy'),
    endpoint('stop'),
    endpoint('setModelsDir'),
    endpoint('scan'),
    endpoint('registerEntry'),
  ],
}

export class LocalLlmGateway extends TypertRemoteService {
  /**
   * @param {Context} ctx 插件宿主上下文（服务随本插件 fiber 存续）
   * @param {{ rpcInvoke(method: string, params: unknown): Promise<unknown> }} svc 服务核
   */
  constructor(ctx, svc) {
    super(ctx, 'localLlm')
    this.rpc = svc
  }

  async call(method, params) {
    return this.rpc.rpcInvoke(method, params)
  }

  async list() { return this.call('list', {}) }
  async preview(params) { return this.call('preview', params) }
  async pull(params) { return this.call('pull', params) }
  async deploy(params) { return this.call('deploy', params) }
  async stop(params) { return this.call('stop', params) }
  async setModelsDir(params) { return this.call('setModelsDir', params) }
  async scan(params) { return this.call('scan', params) }
  async registerEntry(params) { return this.call('registerEntry', params) }
}
