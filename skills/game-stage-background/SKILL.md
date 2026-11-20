---
name: game-stage-background
zh_name: "游戏橱窗与角色展台背景"
en_name: "Game Showcase & Stage Background"
description: |
  Pixel-locked stage and storefront background pipeline for game UI screens
  with 3D or 2D characters (pet/skin showcase, shop window, gacha stage).
  Automatically measures exact character foot coordinates from alpha layers,
  renders spatial layout guides for zero-stretch reference-guided generation,
  and composites UI + character with depth-of-field, frosted empty card slots,
  contact shadows, and floor bounce lighting.
zh_description: |
  面向游戏商店、宠物/皮肤「橱窗」与角色展示界面的像素级空间锚定背景生成与合成工作流。
  自动从角色透明层提取精确脚底坐标并生成同尺寸导引图，配合参考图锁位生图（零猜位置、零拉伸涂抹），
  并一步完成左侧 UI 景深衬托、空卡位磨砂玻璃托底与角色接地光影合成。
triggers:
  - "游戏橱窗背景"
  - "场景背景优化"
  - "商店背景替换"
  - "角色展台背景"
  - "游戏商店界面包装"
  - "game shop background"
  - "character showcase stage"
  - "game UI stage background"
od:
  mode: utility
  surface: image
  category: image-generation
  scenario: game-ui
  design_system:
    requires: false
  example_prompt: "Use game-stage-background to generate and composite 2 collectible diorama showcase backgrounds for my game shop UI without moving the UI or 3D character."
  example_prompt_i18n:
    zh-CN: "使用「游戏橱窗与角色展台背景」技能，在不改动现有 UI 与右侧 3D 角色位置的前提下，生成并合成 2 套与角色画风统一的微缩潮玩橱窗背景完整效果图。"
---

# 游戏橱窗与角色展台背景（像素锁位零拉伸管线）

当用户需要为**带 UI 面板和角色立绘/3D 模型的游戏界面**（如商城、橱窗、皮肤预览、抽卡展台）生成或替换场景背景时，**严禁靠纯文本盲猜展台坐标，也严禁在生图失误后手写模糊脚本修图**。必须严格按以下 4 步执行本技能内置的确定性管线。

## 资源结构

```text
game-stage-background/
|-- SKILL.md
`-- scripts/
    `-- stage_pipeline.py   # 自动测脚底坐标 + 生成空间锚定图 + 零拉伸光学合成
```

---

## 核心铁律（违反任意一条都会导致返工死循环）

1. **先锁坐标再生图，绝不肉眼猜 `plinth_anchor`**：
   必须先运行 `scripts/stage_pipeline.py anchor`，从 `character-layer.png` 的 Alpha 通道自动算出角色精确脚底坐标 `(cx, feet_y)` 并生成同尺寸 `guide.png`。
2. **TapNow 必须传本地参考图（双图锁位），禁止纯文生图盲抽**：
   TapNow MCP 原生支持本地文件上传！调用 `upload_image(upload_method="local_file", file_name=..., content_type="image/png")` 获取 `upload_url` 与 `resource_id`，随后用 `curl -sS -X PUT -H "Content-Type: image/png" --upload-file <path> "<upload_url>"` 上传 `guide.png`（及用户的 Figma/风格参考图），再把 `resource_id` 传入 `create_image(image_ids=[...])`。
3. **强制清空展台主体（防多画公仔/兔子）**：
   Prompt 开头与结尾必须写死：**`EMPTY unoccupied display pedestal at the exact guided position, NO character, NO animal, NO plush toy, NO doll, NO figurine on the central stage`**。
   - **熔断禁令**：万一某张生成图的展台中央仍然多画了公仔/杂物，**绝对禁止编写 `scipy` / 高斯模糊 / 涂抹修补脚本去糊掉它**！只允许加强上述空展台约束并带 `guide.png` 重新调用一次 `create_image`。
4. **TapNow 模型选型与参数避坑表**：
   - **OpenAI 系列首选 `gpt-image-2.6-sunburst`**（`size: "21:9"`, `quality: "high"`, `input_fidelity: "high"`，仅 25 Tapies/张，复杂构图与材质远超旧版 `gpt-image-2` 的 78 Tapies）。除非用户点名要测旧版，否则一律用 `gpt-image-2.6-sunburst`。
   - **`seedream-5.5`**：`aspect_ratio: "21:9"`, `size: "2K"`, 传入 `image_ids=[guide_id, style_ref_id]`。
   - **`midjourney-v8.2`**：使用最宽画幅 `aspect_ratio: "7:4"`, `stylize: 250`。**严禁传 `quality: "hd"`（Schema 不支持会直接报错），Prompt 中严禁出现 `#RRGGBB` 十六进制色值**。
   - **无损原图下载**：`get_production_result` 返回的 `files.tapnow.media` URL 若带 `?variant_name=medium`，下载时**必须去掉 `?variant_name=medium` 参数**以获取满分辨率无损 PNG。
5. **风格语系对齐（防“写实建筑大殿 vs Q 版毛绒角色”割裂）**：
   对圆润 3D 潮玩/毛绒/Q 版角色，场景尺度必须锁定为 **微缩潮玩盲盒橱窗 / 立体书微缩舞台（Collectible Designer-Toy Miniature Diorama, rounded chamfered edges, tactile matte craft / enamel / warm brass / frosted acrylic, shallow depth-of-field）**，禁止生成真人尺度的写实空旷大厅。

---

## 标准 4 步执行流

### Step 1：提取精确锚点并生成空间导引图 `guide.png`

确认项目已拆分出 `character-layer.png` 与 `ui-layer.png`（若尚未拆分，先从原界面分离 UI 层与角色层并保存）。直接运行固定脚本（将 `<SKILL_DIR>` 替换为本技能目录路径）：

```bash
/usr/bin/python3 "<SKILL_DIR>/scripts/stage_pipeline.py" anchor \
  --character "proposals/_source/layers/character-layer.png" \
  --ui "proposals/_source/layers/ui-layer.png" \
  --theme dark \
  --arch gothic \
  --out-guide "proposals/_source/guide_dark.png" \
  --out-meta "proposals/_source/anchor_meta.json"
```

- `--theme`：`dark`（暗调戏剧/魔法/哥特舞台）或 `light`（明亮日销/水晶/纸艺/绘本铺）。
- `--arch`：`gothic`（尖拱花窗）、`round`（圆拱精品龛）或 `frame`（方框微缩盒/立体书舞台）。
- 脚本会自动把角色脚底坐标、画幅比例和自动检测到的空商品卡位写入 `anchor_meta.json`。

### Step 2：上传 `guide.png`（+ 风格参考图）并并行提交生图

1. 用 TapNow `upload_image(upload_method="local_file")` 获取 `upload_url` 与 `resource_id`，用 `curl -X PUT` 完成上传。
2. **并行提交**同一批次的所有 `create_image` 任务（不要串行等待单张出完再发下一张！），随后统一轮询 `get_production_result`。
3. Prompt 模板结构：
   ```text
   2026 collectible designer-toy miniature shop window diorama background (Pop Mart / blind-box display scale), wide 21:9 game showcase screen.
   STRICT SPATIAL LAYOUT following Image 1:
   - Left 46% is a calm, softly defocused wall/shelving backdrop with gentle tonal contrast so shop UI cards remain effortlessly readable.
   - Centered horizontally at 71% width with flat stage top surface at 84% height is an EMPTY unoccupied [material] display pedestal framed by [arch/frame details].
   - Style & materials inspired by Image 2: [concrete material, lighting, and color words — NO hex codes].
   - CRITICAL: COMPLETELY EMPTY unoccupied stage pedestal — NO character, NO animal, NO plush toy, NO doll, NO figurine, NO text, NO watermark.
   ```

### Step 3：下载无损原图并一键精修合成

下载去掉 `?variant_name=medium` 的无损原图后，直接调用 `compose` 子命令（**严禁使用 `mode="edge"` 边缘像素硬拉**）：

```bash
/usr/bin/python3 "<SKILL_DIR>/scripts/stage_pipeline.py" compose \
  --plate "proposals/raw/scene_plate.png" \
  --anchor "proposals/_source/anchor_meta.json" \
  --character "proposals/_source/layers/character-layer.png" \
  --ui "proposals/_source/layers/ui-layer.png" \
  --theme dark \
  --out "proposals/方案_主题名_模型名.png"
```

该命令一次性自动完成：
- 基于 `(cx, feet_y)` 的无拉伸 `LANCZOS` 满幅对齐（自动计算最小必要缩放，绝不产生边缘拉伸条纹）；
- 左侧商品区光学景深柔化（DOF Blur）与微压暗衬底，确保商品卡片清晰跳出；
- 自动为透明空卡位补齐**微磨砂玻璃底板 + 细内描边**，杜绝空槽在深色背景上消失；
- 角色背部柔和轮廓背光光晕、双层脚底接触阴影（AO + Contact Shadow）及台面环境反弹光染色。

### Step 4：单次拼板自检与交付

如需视觉核对，把本批输出缩略拼成 **1 张** 总览图调用 **1 次** `ViewImage` 检查对齐与空展台纯净度即可收工，不要逐张大图反复调用十几次 `ViewImage`。
