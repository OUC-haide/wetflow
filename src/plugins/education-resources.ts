// Explicit equivalents only: paper does not imply printed cards, and a pencil
// does not imply colored pens. Keep the user's wording alongside matched names.
const aliases: Record<string, string[]> = {
  paper: ['纸', '纸张', '白纸', 'a4纸', 'a4白纸', 'a4 paper', 'sheets of paper'],
  'colored pens': ['彩笔', '彩色笔', '水彩笔', '彩色水笔', 'coloured pens', 'color pens', 'colour pens'],
  clay: ['黏土', '粘土', '彩泥', '橡皮泥', 'modeling clay', 'modelling clay'],
  computer: ['电脑', '计算机', '台式电脑', 'desktop computer', 'pc'],
  laptop: ['笔记本电脑', '笔记本计算机', 'laptop computer', 'notebook computer'],
  projector: ['投影仪', '投影机', 'digital projector'],
  internet: ['网络', '互联网', '网络连接', 'internet access', 'internet connection'],
  dice: ['骰子', '色子', 'die'],
  'picture book': ['绘本', '图画书', 'picture books'],
  'printed game cards': ['印刷游戏卡片', '打印的游戏卡片', '打印游戏卡片', 'printed game card'],
  'evidence handouts': ['证据讲义', '证据材料讲义', 'evidence handout'],
  'fruit DNA extraction materials': ['水果dna提取材料', '水果dna提取实验材料'],
  'trained facilitator': ['受训引导员', '经过培训的助教', '受训助教'],
  moderator: ['主持人', '讨论主持人'],
}
const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
const equivalents = new Map(Object.entries(aliases).flatMap(([canonical, names]) =>
  [canonical, ...names].map(name => [normalize(name), canonical] as const)))
const uncertain = /待确认|待定|未确认|可选|如果|若|可能|建议|可借|需购买|需要购买|\b(?:optional|if|maybe|unconfirmed|to be confirmed|to confirm|could|might|need to buy)\b/i
const absent = /没有|无(?:电脑|投影|黏土|粘土|网络|纸|彩笔)|不提供|不具备|不可用|\b(?:no|not available|without|unavailable)\b/i

function names(value: string) {
  const normalized = normalize(value)
  const exact = equivalents.get(normalized)
  if (exact) return [exact]
  // A parenthetical description is safe only after the absence/uncertainty
  // check. For example, "纸（A4白纸）" still denotes paper.
  return normalized.replace(/\([^)]*\)/g, '').split(/[、,;/，；]|\s+(?:and|&)\s+|和|与/)
    .map(part => normalize(part)).filter(Boolean).map(part => equivalents.get(part) ?? part)
}

export function educationResources(resources: string[], optionalResources: string[] = []) {
  const available: string[] = [], pending = [...optionalResources], unavailable: string[] = []
  const confirmed = new Set<string>()
  for (const value of resources) {
    if (uncertain.test(value)) { pending.push(value); continue }
    if (absent.test(value)) { unavailable.push(value); continue }
    available.push(value)
    for (const name of names(value)) confirmed.add(name)
  }
  // A laptop satisfies a generic computer requirement, not vice versa.
  if (confirmed.has('laptop')) confirmed.add('computer')
  return { available, pending: [...new Set(pending)], unavailable,
    missing: (required: string[]) => required.filter(value => !names(value).every(name => confirmed.has(name))),
  }
}
