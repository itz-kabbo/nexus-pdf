# 生成应用图标 1024x1024: 蓝色渐变圆角矩形 + 白色折角书页 + 速度光痕 (轻系列家族语言)
# 用法: uv run --with pillow python scripts/make_icon.py
from PIL import Image, ImageDraw, ImageFilter

S = 1024
M = 78
R = 200
SS = 4
s, m, r = S * SS, M * SS, R * SS

# ---- 渐变底 (与轻影同款: 亮蓝 -> 深蓝) ----
top = (61, 127, 255)
bottom = (11, 74, 204)
grad = Image.new("RGB", (s, s))
px = grad.load()
for y in range(s):
    for x in range(0, s, 8):
        t = (x + y) / (2 * s)
        c = tuple(int(a + (b - a) * t) for a, b in zip(top, bottom))
        for dx in range(8):
            if x + dx < s:
                px[x + dx, y] = c

light = Image.new("L", (s, s), 0)
ld = ImageDraw.Draw(light)
ld.ellipse([-s * 0.35, -s * 0.45, s * 0.75, s * 0.55], fill=70)
light = light.filter(ImageFilter.GaussianBlur(s * 0.10))
white = Image.new("RGB", (s, s), (255, 255, 255))
grad = Image.composite(white, grad, light.point(lambda v: v))

mask = Image.new("L", (s, s), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([m, m, s - m, s - m], radius=r, fill=255)

icon = Image.new("RGBA", (s, s), (0, 0, 0, 0))
icon.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(icon)

# ---- 白色折角书页 (居右, 光学居中) ----
pw, ph = s * 0.30, s * 0.42
px0, py0 = s * 0.435, (s - ph) / 2
fold = pw * 0.34  # 折角尺寸
rad = s * 0.028

# 页面主体: 圆角矩形去掉右上角
page = Image.new("L", (s, s), 0)
pd = ImageDraw.Draw(page)
pd.rounded_rectangle([px0, py0, px0 + pw, py0 + ph], radius=rad, fill=255)
# 切掉右上折角区域
pd.polygon([(px0 + pw - fold, py0 - 2), (px0 + pw + 2, py0 - 2), (px0 + pw + 2, py0 + fold)], fill=0)
icon.paste((255, 255, 255, 255), (0, 0), page)

# 折角: 浅蓝三角 (翻折的背面)
d.polygon(
    [(px0 + pw - fold, py0), (px0 + pw - fold, py0 + fold), (px0 + pw, py0 + fold)],
    fill=(178, 205, 255, 255),
)

# 页面上的文字线条 (淡蓝)
line_c = (120, 165, 255, 255)
lw = int(s * 0.026)
lx = px0 + pw * 0.18
for i, wfrac in enumerate([0.42, 0.64, 0.64, 0.45]):
    y = py0 + ph * (0.30 + i * 0.155)
    d.line([(lx, y), (lx + pw * wfrac, y)], fill=line_c, width=lw)
    for ex in (lx, lx + pw * wfrac):
        d.ellipse([ex - lw / 2, y - lw / 2, ex + lw / 2, y + lw / 2], fill=line_c)

# ---- 左侧三道速度光痕 (家族签名) ----
lw2 = int(s * 0.052)
lx2 = s * 0.20
cy = s * 0.5
for dy, ln in [(-0.155, 0.115), (0.0, 0.082), (0.155, 0.115)]:
    y = cy + s * dy
    d.line([(lx2, y), (lx2 + s * ln, y)], fill=(255, 255, 255, 225), width=lw2)
    for ex in (lx2, lx2 + s * ln):
        d.ellipse([ex - lw2 / 2, y - lw2 / 2, ex + lw2 / 2, y + lw2 / 2], fill=(255, 255, 255, 225))

icon = icon.resize((S, S), Image.LANCZOS)
icon.save("src-tauri/app-icon.png")
print("OK -> src-tauri/app-icon.png")
