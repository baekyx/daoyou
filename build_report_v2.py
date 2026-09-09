from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.section import WD_SECTION
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.text import WD_BREAK


OUT = "/Users/BitLukou-004/Downloads/任务二可行性评估报告修订版v2.docx"
BLUE = "1F4E78"
LIGHT = "EAF1F7"
GRAY = "F2F4F7"
INK = "1F2937"
MUTED = "667085"
RED = "9B1C1C"
GOLD = "7A5A00"


def set_font(run, name="Hiragino Sans GB", size=10.5, bold=None, color=INK):
    run.font.name = name
    run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), name)
    run._element.rPr.rFonts.set(qn("w:ascii"), name)
    run._element.rPr.rFonts.set(qn("w:hAnsi"), name)
    run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if color:
        run.font.color.rgb = RGBColor.from_string(color)


def shade(cell, fill):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = tcPr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tcPr.append(shd)
    shd.set(qn("w:fill"), fill)


def cell_margins(cell, top=100, start=120, bottom=100, end=120):
    tc = cell._tc
    tcPr = tc.get_or_add_tcPr()
    tcMar = tcPr.first_child_found_in("w:tcMar")
    if tcMar is None:
        tcMar = OxmlElement("w:tcMar")
        tcPr.append(tcMar)
    for m, v in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tcMar.find(qn(f"w:{m}"))
        if node is None:
            node = OxmlElement(f"w:{m}")
            tcMar.append(node)
        node.set(qn("w:w"), str(v))
        node.set(qn("w:type"), "dxa")


def set_cell_width(cell, dxa):
    tcPr = cell._tc.get_or_add_tcPr()
    tcW = tcPr.find(qn("w:tcW"))
    if tcW is None:
        tcW = OxmlElement("w:tcW")
        tcPr.append(tcW)
    tcW.set(qn("w:w"), str(dxa))
    tcW.set(qn("w:type"), "dxa")


def configure_table(table, widths):
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    table.autofit = False
    tblPr = table._tbl.tblPr
    tblW = tblPr.find(qn("w:tblW"))
    if tblW is None:
        tblW = OxmlElement("w:tblW")
        tblPr.append(tblW)
    tblW.set(qn("w:w"), str(sum(widths)))
    tblW.set(qn("w:type"), "dxa")
    tblInd = tblPr.find(qn("w:tblInd"))
    if tblInd is None:
        tblInd = OxmlElement("w:tblInd")
        tblPr.append(tblInd)
    tblInd.set(qn("w:w"), "120")
    tblInd.set(qn("w:type"), "dxa")
    grid = table._tbl.tblGrid
    for child in list(grid):
        grid.remove(child)
    for w in widths:
        col = OxmlElement("w:gridCol")
        col.set(qn("w:w"), str(w))
        grid.append(col)
    for row in table.rows:
        for i, cell in enumerate(row.cells):
            set_cell_width(cell, widths[i])
            cell_margins(cell)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER


def style_cell_text(cell, bold=False, color=INK, size=9.2, align=WD_ALIGN_PARAGRAPH.LEFT):
    for p in cell.paragraphs:
        p.alignment = align
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
        p.paragraph_format.line_spacing = 1.08
        for r in p.runs:
            set_font(r, size=size, bold=bold, color=color)


def add_table(doc, headers, rows, widths, compact=False):
    table = doc.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    for i, h in enumerate(headers):
        table.rows[0].cells[i].text = h
        shade(table.rows[0].cells[i], GRAY)
        style_cell_text(table.rows[0].cells[i], bold=True, size=8.8 if compact else 9.2)
    for row in rows:
        cells = table.add_row().cells
        for i, value in enumerate(row):
            cells[i].text = str(value)
            style_cell_text(cells[i], size=8.5 if compact else 9.1)
    configure_table(table, widths)
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(1)
    return table


def add_hyperlink(paragraph, text, url):
    part = paragraph.part
    rid = part.relate_to(url, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", is_external=True)
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), rid)
    run = OxmlElement("w:r")
    rPr = OxmlElement("w:rPr")
    color = OxmlElement("w:color")
    color.set(qn("w:val"), BLUE)
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    rPr.extend([color, underline])
    text_node = OxmlElement("w:t")
    text_node.text = text
    run.extend([rPr, text_node])
    hyperlink.append(run)
    paragraph._p.append(hyperlink)


def para(doc, text="", bold=False, color=INK, size=10.5, after=6, align=None):
    p = doc.add_paragraph()
    if align is not None:
        p.alignment = align
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(after)
    p.paragraph_format.line_spacing = 1.12
    r = p.add_run(text)
    set_font(r, size=size, bold=bold, color=color)
    return p


def bullet(doc, text, level=0):
    p = doc.add_paragraph(style="List Bullet")
    p.paragraph_format.left_indent = Inches(0.5 + 0.25 * level)
    p.paragraph_format.first_line_indent = Inches(-0.25)
    p.paragraph_format.space_after = Pt(5)
    p.paragraph_format.line_spacing = 1.12
    set_font(p.add_run(text), size=10.2)
    return p


def numbered(doc, text):
    p = doc.add_paragraph(style="List Number")
    p.paragraph_format.left_indent = Inches(0.5)
    p.paragraph_format.first_line_indent = Inches(-0.25)
    p.paragraph_format.space_after = Pt(5)
    p.paragraph_format.line_spacing = 1.12
    set_font(p.add_run(text), size=10.2)
    return p


def heading(doc, text, level=1):
    return doc.add_paragraph(text, style=f"Heading {level}")


def callout(doc, label, text, fill=LIGHT, label_color=BLUE):
    table = doc.add_table(rows=1, cols=1)
    table.style = "Table Grid"
    cell = table.cell(0, 0)
    shade(cell, fill)
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(2)
    r = p.add_run(label + "  ")
    set_font(r, size=10.3, bold=True, color=label_color)
    r = p.add_run(text)
    set_font(r, size=10.3, color=INK)
    configure_table(table, [9360])
    para(doc, "", after=2)


doc = Document()
sec = doc.sections[0]
sec.page_width = Inches(8.5)
sec.page_height = Inches(11)
sec.top_margin = Inches(0.78)
sec.bottom_margin = Inches(0.72)
sec.left_margin = Inches(0.9)
sec.right_margin = Inches(0.9)
sec.header_distance = Inches(0.35)
sec.footer_distance = Inches(0.35)

styles = doc.styles
normal = styles["Normal"]
normal.font.name = "Hiragino Sans GB"
normal._element.rPr.rFonts.set(qn("w:eastAsia"), "Hiragino Sans GB")
normal._element.rPr.rFonts.set(qn("w:ascii"), "Hiragino Sans GB")
normal._element.rPr.rFonts.set(qn("w:hAnsi"), "Hiragino Sans GB")
normal.font.size = Pt(10.5)
normal.font.color.rgb = RGBColor.from_string(INK)
normal.paragraph_format.space_after = Pt(6)
normal.paragraph_format.line_spacing = 1.12
for level, size, before, after in ((1, 16, 14, 7), (2, 13, 10, 5), (3, 11.5, 7, 3)):
    s = styles[f"Heading {level}"]
    s.font.name = "Hiragino Sans GB"
    s._element.rPr.rFonts.set(qn("w:eastAsia"), "Hiragino Sans GB")
    s._element.rPr.rFonts.set(qn("w:ascii"), "Hiragino Sans GB")
    s._element.rPr.rFonts.set(qn("w:hAnsi"), "Hiragino Sans GB")
    s.font.size = Pt(size)
    s.font.bold = True
    s.font.color.rgb = RGBColor.from_string(BLUE if level < 3 else INK)
    s.paragraph_format.space_before = Pt(before)
    s.paragraph_format.space_after = Pt(after)
    s.paragraph_format.keep_with_next = True

header = sec.header.paragraphs[0]
header.alignment = WD_ALIGN_PARAGRAPH.RIGHT
set_font(header.add_run("预置 OpenClaw 的 SSD 移动硬盘产品开发｜可行性评估"), size=8.5, color=MUTED)
footer = sec.footer.paragraphs[0]
footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
set_font(footer.add_run("修订版 v2 · 2026 年 8 月"), size=8, color=MUTED)

# Cover / executive conclusion
para(doc, "可行性评估报告", bold=True, color=BLUE, size=11, after=16)
para(doc, "预置 OpenClaw 的 SSD", bold=True, color="0B2545", size=23, after=1)
para(doc, "移动硬盘产品开发", bold=True, color="0B2545", size=23, after=8)
para(doc, "修订版 v2｜技术口径澄清稿", color=MUTED, size=13, after=16)
add_table(doc, ["项目", "内容"], [
    ["编制", "周欢洋（牵头人）"],
    ["技术方案", "徐北楠、曾煜曦（共同执行）"],
    ["功能规划 / 顾问", "张桐豪 / 马云祥、刘浩宇"],
    ["总协调", "王楚雄"],
    ["修订说明", "明确 SSD 预置内容、云端 API 推理与数据边界；其余预算、排期沿用 v1 待核。"],
], [1700, 7660])

heading(doc, "〇、总体结论", 1)
callout(doc, "结论", "技术可行，建议有条件立项。样品目标为 Windows 半便携运行盘；本阶段采用云端大模型 API，不在 SSD 内预置或运行大模型。")
bullet(doc, "SSD 中预置：OpenClaw、便携式 Node 运行时、启动/恢复脚本、人格与工具配置模板，以及配置、会话、记忆、日志和用户文件目录。")
bullet(doc, "SSD 中不预置：GPT、Claude、DeepSeek 等大模型权重，也不附带任何第三方 API Key。首次启动由用户填入自己的 Key，并联网调用所选模型服务。")
bullet(doc, "“数据留在盘上”的准确含义是本地持久化副本默认写入 SSD；为完成推理，用户输入及任务所需的文件片段会发送给所选云端模型服务商，不能宣传为“完全不上云、不外流”。")
bullet(doc, "周期约 5～6 周；样品期总成本约 1.1～1.6 万元；第 3 周末干净机 PoC 不通过则降级为 V1 安装盘。")

heading(doc, "关键技术口径：到底放什么在 SSD 里？", 1)
add_table(doc, ["层次", "本阶段位置", "说明"], [
    ["OpenClaw 与运行时", "SSD 本地", "便携 Node、OpenClaw 程序、依赖、启动器、版本锁定文件。"],
    ["脚本与预置配置", "SSD 本地", "启动、更新、恢复出厂、路径适配脚本；BOOTSTRAP / SOUL / TOOLS 等模板。"],
    ["用户持久化数据", "SSD 本地为主", "配置、会话、记忆、日志、用户文件默认写入盘内；需验证无盘外残留。"],
    ["大模型推理", "云端 API", "用户自带 Key；联网调用 GPT / Claude / DeepSeek 等。请求内容受对应服务商的数据政策约束。"],
    ["大模型权重", "不预置", "本阶段明确不跑本地模型，避免 GPU/内存门槛、模型体积与授权复杂度。"],
], [1650, 1700, 6010], compact=True)
callout(doc, "一句话答复", "本阶段是“OpenClaw 和脚本放 SSD，本地保存工作数据；大模型通过云端 API 调用”。不是把大模型放进 SSD。", fill="FFF4E5", label_color=GOLD)

heading(doc, "一、需要多少人", 1)
para(doc, "按现有团队配置执行；技术执行由徐北楠、曾煜曦共同承担，刘浩宇任评审顾问。")
add_table(doc, ["姓名", "角色", "职责"], [
    ["周欢洋", "牵头人", "报告统稿、周期与人力评估、总接口、验收组织。"],
    ["徐北楠", "技术方案（共同执行）", "运行时打包、启动脚本、双端技术路线、硬件与成本核算。"],
    ["曾煜曦", "技术方案（共同执行）", "打包、测试、母盘克隆、安全与数据边界核验。"],
    ["张桐豪", "功能规划", "预装能力清单、开箱体验、功能完成度与提示文案。"],
    ["马云祥", "Mac 顾问（轻量）", "macOS 可行性验证，不承担主开发。"],
    ["刘浩宇", "评审顾问", "从 AI 产品化和风险口径进行成稿、样品验收评审。"],
    ["王楚雄", "总协调", "对接王院长与研究院，进度和质量总负责。"],
], [1100, 2100, 6160], compact=True)
para(doc, "徐北楠、曾煜曦双人执行、互为备份；进入量产阶段后再评估增补生产与测试人力。", color=MUTED, size=9.5)

heading(doc, "二、功能开发到什么程度", 1)
heading(doc, "2.1 产品分期", 2)
add_table(doc, ["版本", "形态", "定义", "本阶段态度"], [
    ["V1", "便携安装盘", "盘内为安装包、模板和手册；用户本机安装一次。", "降级预案"],
    ["V2", "Windows 半便携运行盘", "盘内自带运行时与 OpenClaw；脚本直启；本地数据写盘；联网调用模型 API。", "样品目标"],
    ["V3", "Windows + macOS", "双端、多架构、产品化；可另行评估本地模型或私有推理端点。", "二期再议"],
], [700, 1900, 5200, 1560], compact=True)

heading(doc, "2.2 用户拿到手的第一体验", 2)
callout(doc, "标准流程", "插盘 → 双击启动器 → 填 API Key 并确认数据提示 → 联网开始使用（4 步）。")
para(doc, "目标是不安装 Node、Git、Docker，不要求管理员权限。配置、会话、记忆和用户文件的本地副本保存在盘内，换电脑后可继续使用；云端模型调用需要网络。")

heading(doc, "2.3 预装能力", 2)
para(doc, "首页四张任务卡和一个自由输入框：写东西、读文件、查资料、整理文件夹；背后为一个主 Agent，共用同一套记忆。任务卡仅封装流程，不代表模型已存放在 SSD。")

heading(doc, "2.4 初始化与配置", 2)
para(doc, "工厂侧预置人格与能力边界（BOOTSTRAP → SOUL → TOOLS 等配置）；用户侧首次启动选择模型服务商、填入自己的 API Key，并确认：哪些内容会发送给服务商、哪些内容留在 SSD。产品不附带任何 API Key。")

heading(doc, "2.5 功能清单与验收硬标准", 2)
for t in [
    "干净 Win10 / Win11（无 Node、Git、Docker）插盘可启动，冷启动目标 2 分钟以内。",
    "盘符变化仍可启动；三台电脑换插数据不丢；异常断电后可恢复，且不损坏核心配置。",
    "配置、会话、记忆、日志和用户文件默认写入 SSD；通过系统目录扫描验证盘外无非必要持久化残留。",
    "首次启动可自填 API Key，可接入至少两类云端模型提供商；断网时明确提示“模型服务不可用”，不作离线推理承诺。",
    "界面在首次发送前展示数据边界：请求及必要文件片段可能传给模型服务商；本地完整副本仍保存在 SSD。",
    "四张任务卡可用；一键恢复出厂预置只清用户数据、保留工厂配置，并需二次确认。",
    "22 项基本功能全过；联网研究、备份迁移、更新回滚三项至少完成两项。",
]: numbered(doc, t)

heading(doc, "2.6 明确不做", 2)
para(doc, "macOS、Windows ARM、本地大模型、消息通道、定时任务、多 Agent 编排、企业知识库；不以 Docker/WSL2 为前提；不安装 Windows 系统服务；不附带 API Key、客户数据或默认密码。任何变更须经牵头人审批。")

heading(doc, "2.7 对外宣传口径", 2)
callout(doc, "推荐表述", "“支持指定版本 Windows 环境的便携式 OpenClaw 运行与交付；运行环境与本地持久化数据随盘携带，模型能力由用户选择的云端 API 提供。”")
para(doc, "禁止使用：“完全离线”“数据绝不上云”“插上任意电脑就能用”“SSD 内置 GPT/Claude/DeepSeek 大模型”等与当前方案不符的绝对化表述。", bold=True, color=RED)

heading(doc, "三、成本是多少", 1)
heading(doc, "3.1 硬件成本：样品期控制在 800 元以内", 2)
add_table(doc, ["项目", "内容", "预估金额（待询价）"], [
    ["SSD 样品盘", "2～3 块，USB 3.2 / USB-C；一块母盘，其余对比/备用。容量建议先验证 128GB 是否足够。", "约 400～700 元"],
    ["线材/转接头", "视现有设备补充。", "0～50 元"],
    ["样品期合计", "实报实销，保留票据。", "≤800 元"],
], [1500, 5800, 2060], compact=True)

heading(doc, "3.2 开发期算力成本", 2)
para(doc, "本阶段不训练、不运行本地模型、无需采购 GPU；算力成本为开发测试期调用云端 API 的费用。")
add_table(doc, ["测试策略", "估算金额"], [
    ["主用 DeepSeek 等低成本模型完成约 800～1000 轮测试（token 量需按实际日志核算）", "约 50～100 元"],
    ["混用 GPT / Claude 验证多提供商接入和关键验收", "约 200～500 元"],
    ["预算上限", "≤500 元（实报实销）"],
], [7000, 2360])
para(doc, "交付后，用户使用阶段的 API 费用由其自填 Key 自担，不计入本项目成本；模型价格变化不影响硬件边际成本，但会影响用户持续使用成本。", color=MUTED, size=9.5)

heading(doc, "3.3 量产边际成本", 2)
add_table(doc, ["构成", "预估（待询价）"], [
    ["SSD 硬盘（128GB）", "约 130～250 元/块"],
    ["包装与说明书", "约 5～20 元/块"],
    ["单盘边际合计（不含人工）", "约 135～270 元/块"],
], [6000, 3360])

heading(doc, "3.4 人工成本（暂估）", 2)
add_table(doc, ["分组", "工作内容", "折算金额"], [
    ["技术执行", "4 周主力：打包、脚本、测试、克隆、安全与数据边界核验。", "约 5400～8100 元"],
    ["产品与统筹", "报告、功能清单、开箱体验、提示文案、验收组织。", "约 3900～5400 元"],
    ["Mac 验证", "2～3 天轻量验证。", "约 600～900 元"],
    ["合计", "按 300 元/天暂估，最终按确认的报酬标准校准。", "约 1.0～1.4 万元"],
], [1800, 5300, 2260], compact=True)

heading(doc, "3.5 成本总览", 2)
add_table(doc, ["成本项", "金额"], [
    ["硬件（样品期）", "≤800 元"],
    ["算力（开发期 API）", "≤500 元"],
    ["人工（样品期）", "约 1.0～1.4 万元"],
    ["样品期总成本", "约 1.1～1.6 万元"],
    ["量产后单盘边际成本", "约 135～270 元/块"],
], [6000, 3360])
callout(doc, "成本边界", "上述金额不含本地模型所需 GPU/高内存主机，也不含用户交付后的模型 API 消耗。若后续改为本地模型路线，须重新估算硬件规格、模型授权、散热与兼容性。")

heading(doc, "四、周期是多长", 1)
heading(doc, "4.1 总体口径", 2)
para(doc, "评估 1 周 + 开发 4 周（预留 1 周弹性），合计约 5～6 周交付样品。")

heading(doc, "4.2 可行性评估（第 1 周）", 2)
para(doc, "完成报告讨论、分工、技术与成本核对、统稿；本周末提交初稿，由院长审阅决定是否立项。技术核对重点包括：SSD 询价、干净机插盘启动、许可证商用约束，以及 API 数据边界。")

heading(doc, "4.3 样品开发（第 2～5 周）", 2)
add_table(doc, ["周次", "主要工作", "里程碑", "负责"], [
    ["第 2 周", "采购 SSD；跑通官方 OpenClaw；建立 app/runtime/profile/logs/launcher 目录；锁定版本和文件系统。", "本机插盘脚本可启动", "徐北楠、曾煜曦"],
    ["第 3 周", "便携 Node 打盘；干净机启动；验证盘符变化、普通权限；Mac 轻量验证并行。", "干净机 PoC；不通则降 V1", "徐北楠、曾煜曦；马云祥"],
    ["第 4 周", "预置模板、Key 引导、数据提示、恢复出厂；测试 Win10/11、拔插、断网、杀软与盘外残留。", "开箱四步走通；清单全过", "技术组 + 张桐豪"],
    ["第 5 周", "冻结母盘；克隆验证；按标准演示验收；固化第三方许可与隐私说明。", "母盘 + 克隆盘通过验收", "技术组；周欢洋组织；刘浩宇评审"],
], [850, 4900, 1900, 1710], compact=True)

heading(doc, "4.4 弹性与降级", 2)
callout(doc, "降级红线", "第 3 周末干净机 PoC 不通，当周切换 V1 安装盘，周期与预算不变。")
para(doc, "顺利时 3 周可完成样品，最多预留至 5 周。关键依赖：SSD 采购需在第 2 周头两日完成；功能清单和数据提示文案需在第 4 周前冻结。")

heading(doc, "五、关键风险与立项条件", 1)
add_table(doc, ["风险", "影响", "立项前 / 样品期控制措施"], [
    ["隐私口径失真", "将云端 API 方案宣传成“数据不上云”，产生投诉和合规风险。", "统一采用本报告口径；首次发送前显著提示数据去向；说明第三方服务条款由用户确认。"],
    ["便携性不稳定", "盘符、权限、杀软或路径长度导致无法启动。", "第 3 周前完成干净机 PoC；锁版本；相对路径；三机换插与杀软测试。"],
    ["API Key 泄露", "用户凭据被读取、复制或写入日志。", "不预置 Key；禁止明文日志；优先系统凭据库或加密存储；恢复出厂彻底清除。"],
    ["开源许可 / 商标", "复制销售或宣传使用受限制。", "由技术负责人核对 OpenClaw 及依赖许可；保留 LICENSE / NOTICE；未经授权不暗示官方合作。"],
    ["成本与体验漂移", "模型费率、接口或版本变化造成不可控体验。", "提供商抽象层、版本锁定、更新回滚；对外明确 API 费用由用户承担。"],
], [1900, 2900, 4560], compact=True)
callout(doc, "建议立项条件", "只有在“云端 API + 本地持久化”的真实口径获批准、干净机 PoC 可在第 3 周完成、许可证与 Key 存储方案通过技术核对后，才进入 V2 样品开发。")

heading(doc, "附录 A｜待核对项汇总", 1)
add_table(doc, ["#", "事项", "负责人", "时限"], [
    ["1", "逐周开发计划评审；干净机 PoC；OpenClaw 与依赖许可证商用约束。", "徐北楠、曾煜曦", "本周内"],
    ["2", "核实官方支持的模型提供商接入、API Key 存储方式、请求日志与数据传输范围。", "徐北楠、曾煜曦", "本周内"],
    ["3", "SSD 询价（2～3 块，样品总额 ≤800 元），保留报价截图。", "徐北楠、曾煜曦", "本周内"],
    ["4", "任务卡、开箱文案、首次发送前的数据提示、盘外访问和最小可写目录冻结。", "张桐豪", "第 3 周末前"],
    ["5", "Mac 轻量验证时间确认。", "马云祥", "第 2 周前"],
    ["6", "成稿和样品验收评审（AI 产品化、隐私与宣传口径）。", "刘浩宇", "初稿提交后"],
    ["7", "采购报销、对外宣传口径和人工成本标准确认。", "王楚雄、周欢洋", "本周内 / 标准确认后 2 日"],
], [500, 5540, 1900, 1420], compact=True)

heading(doc, "附录 B｜技术依据与版本说明", 1)
para(doc, "本报告对架构的判断依据如下：OpenClaw 可配置多种模型提供商，也可对接本地/自托管端点；这说明“OpenClaw 在本地运行”与“模型在本地推理”是两个不同层次。本阶段主动选择前者 + 云端 API，并明确排除本地模型。", size=10.2)
p = para(doc, "• OpenClaw 官方文档：", after=3)
add_hyperlink(p, "Model providers", "https://docs.openclaw.ai/concepts/model-providers")
p = para(doc, "• OpenClaw 官方文档：", after=3)
add_hyperlink(p, "Models CLI / provider configuration", "https://docs.openclaw.ai/cli/models")
p = para(doc, "• OpenClaw 官方仓库：", after=3)
add_hyperlink(p, "OpenAI provider documentation", "https://github.com/openclaw/openclaw/blob/main/docs/providers/openai.md")
para(doc, "注：模型服务商的数据使用、保留与地域政策应在产品交付时链接到用户所选服务商的最新条款；本报告不替代法律或合规审查。", color=MUTED, size=9.2)

heading(doc, "附录 C｜相对 v1 的实质修订", 1)
add_table(doc, ["位置", "v2 修订"], [
    ["总体结论", "增加“本阶段采用云端模型 API，不在 SSD 内运行模型”。"],
    ["开箱体验", "由“填 Key → 开始对话”改为“填 Key + 确认数据提示 → 联网使用”。"],
    ["数据承诺", "将“数据全部留盘、不上云”改为“本地副本留盘；推理所需内容会发送给服务商”。"],
    ["验收标准", "新增断网提示、盘外残留扫描、数据边界提示和 Key 日志检查。"],
    ["宣传口径", "禁止“完全离线、数据绝不上云、SSD 内置大模型”等不实表述。"],
    ["风险与条件", "新增隐私口径、Key 泄露、许可证与接口变化风险。"],
], [2100, 7260], compact=True)

doc.core_properties.title = "预置 OpenClaw 的 SSD 移动硬盘产品开发可行性评估报告（修订版 v2）"
doc.core_properties.subject = "澄清 SSD 本地预置与云端模型 API 的技术边界"
doc.core_properties.author = "项目组 / Codex 辅助修订"
doc.save(OUT)
print(OUT)
