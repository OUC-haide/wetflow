import { modelImage, readBoundedFile } from './local-file.js'
import type { ChatAttachment } from '../core/types.js'
import type { WetFlowContext } from './types.js'
export const name = 'wetflow-document-media'
export const inject = ['wetflow', 'wetflowLocalFiles']
export function apply(ctx: WetFlowContext): void {
  const service = {
    image: async (item: ChatAttachment) => modelImage(await readBoundedFile(item.path), `[文件: ${item.name}]`),
  }
  ctx.reflect.provide('wetflowDocumentMedia', service)
  ctx.effect(() => ctx.wetflowLocalFiles!.enableMedia(service), 'PDF and image reader registration')
  ctx.effect(() => ctx.wetflow.tools.mount('document-media', registry => {
    registry.registerInstructions('document-media', 'PDF 与多模态插件已启用：local_file_read 支持 PDF 逐页读取，扫描页和图表使用 mode=image。图片作为真实视觉内容提供，不能凭文件名猜测。所选模型必须支持视觉输入；文字模糊或图片未读取时明确说明。')
  }), 'Document media policy')
}
