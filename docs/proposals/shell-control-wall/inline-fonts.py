"""把 IBM Plex Sans 与 JetBrains Mono 的拉丁子集以 data URI 内联进原型 HTML，原型因此不依赖网络和 node_modules。

用法：python3 -I inline-fonts.py <@fontsource 所在目录> a-adjust.html b-wall.html
<@fontsource 所在目录> 例如 apps/web/node_modules（pnpm install 之后）。只替换
`/* fonts:start */` 与 `/* fonts:end */` 之间的内容，重复运行结果不变。
"""

import base64
import re
import sys
from pathlib import Path

FACES = [
    ("IBM Plex Sans", "ibm-plex-sans", w) for w in (400, 500, 600)
] + [("JetBrains Mono", "jetbrains-mono", w) for w in (400, 500, 600)]


def font_css(root: Path) -> str:
    rules = []
    for family, pkg, weight in FACES:
        path = root / "@fontsource" / pkg / "files" / f"{pkg}-latin-{weight}-normal.woff2"
        data = base64.b64encode(path.read_bytes()).decode()
        rules.append(
            f"@font-face{{font-family:'{family}';font-weight:{weight};font-style:normal;"
            f"font-display:block;src:url(data:font/woff2;base64,{data}) format('woff2')}}"
        )
    return "\n".join(rules)


def main() -> None:
    root, *files = sys.argv[1:]
    css = font_css(Path(root))
    pattern = re.compile(r"/\* fonts:start \*/.*?/\* fonts:end \*/", re.S)
    for name in files:
        path = Path(name)
        html = path.read_text(encoding="utf-8")
        if not pattern.search(html):
            sys.exit(f"{name}: 没有 fonts:start / fonts:end 标记")
        replaced = pattern.sub(lambda _: f"/* fonts:start */\n{css}\n/* fonts:end */", html)
        path.write_text(replaced, encoding="utf-8")


if __name__ == "__main__":
    main()
