/** Team-defined framework, owned by the plugin rather than retrieved case text. */
export const WEAVE_CYCLE = [
  { phase: 'Wonder', label: '思索', question: 'Why do we design this activity?',
    purpose: 'Identify the intended audience, why it was chosen, its learning needs, questions and knowledge gaps, using project context and any available prior feedback.',
    deliverable: 'A reason for the activity and explicitly stated needs or assumptions to confirm.', status: 'planning' },
  { phase: 'Explore', label: '探索', question: 'How can we design for meaningful learning?',
    purpose: 'Define clear learning objectives and choose scientific content, communication methods and interactive formats suited to the audience.',
    deliverable: 'Objective-led design choices with attributed source practices and proposed adaptations.', status: 'planning' },
  { phase: 'Action', label: '落地', question: 'How do we bring the design to life?',
    purpose: 'Translate the design into practical online or offline actions using the available resources.',
    deliverable: 'An implementable classroom plan; its activity timings must total durationMinutes.', status: 'proposed_not_delivered' },
  { phase: 'Verify', label: '核验', question: 'What did participants gain?',
    purpose: 'Use participant feedback and evaluation to examine whether the intended objectives were achieved and what participants gained.',
    deliverable: 'For a prospective task, specify evidence to collect and assessment criteria; outcomes remain unmeasured.', status: 'awaiting_classroom_evidence' },
  { phase: 'Echo', label: '回响', question: 'What can we improve next?',
    purpose: 'Collect feedback, reflect on strengths and limitations, and translate findings into improvements implemented and evaluated in later iterations.',
    deliverable: 'A feedback-to-revision plan; distinguish proposed improvements from implemented and evaluated changes.', status: 'awaiting_feedback_and_iteration' },
] as const

export const EDUCATION_WEAVE_POLICY = `Education 插件已启用。WEAVE 是当前 Agent 的全局教育规划规则，每轮对话都生效，不以用户是否提到 WEAVE 或是否调用工具为条件。
所有教育活动设计、方案修改、实施规划、效果核验和复盘，必须依据团队定义的完整 WEAVE 循环组织工作：
W—Wonder（思索）：结合本项目与已有反馈，说明为什么设计活动、为什么选择该受众和主题，明确学习需求、疑惑和知识短板。
E—Explore（探索）：采用目标导向式设计，先明确学习目标，再匹配年龄、科学内容、沟通方式与互动形式。
A—Action（落地）：把目标转化为可执行的线上或线下行动，明确材料、人员和实施安排。
V—Verify（核验）：围绕学习目标设计参与者反馈与评价方法；有真实反馈时分析收获，没有时提出评估计划。
E—Echo（回响）：把收集反馈、复盘反思、迭代升级连起来，说明后续如何落实并再次评估改进。
规划前先用 education_search_cases 浏览教育案例类型，再按主题、受众与类型检索案例。往年团队案例是可借鉴的资料，不能替代当前受众需求。
当受众、目标、时长和资源已明确时，调用 education_make_brief，把来源、适配条件和五阶段设计要求一起用于方案。信息不足时明确待确认项，不编造反馈、资源或教学效果。
完整方案必须交代五阶段各自的内容及其前后联系，并给出简明的选择依据；后续局部修改保留原有框架，只展开受影响部分。普通事实查询可简洁回答。
课内时间安排属于 Action 的实施细节，不能把 WEAVE 误写成五个按分钟分配的课堂环节，也不能把 Wonder 简化为开场热身。
检索所得的实践、资源和提案必须区分状态并署名。借鉴建议要明确为本次适配，未经实际实施不能写成已取得教学成效。
此规则约束教育规划的工作方式和可见交付内容，不要求展示隐藏思维链。与教育无关的科研事实查询保持原任务语义。`
