"""Bundle index.html + css + js into one self-contained demo page (for sharing a preview)."""
import re, sys, pathlib
root = pathlib.Path(sys.argv[1]); out = pathlib.Path(sys.argv[2])
h = (root / "index.html").read_text(encoding="utf-8")
h = re.sub(r"<!doctype html>\s*<html[^>]*>\s*<head>", "", h, flags=re.I)
h = re.sub(r"</head>\s*<body>", "", h, flags=re.I)
h = re.sub(r"</body>\s*</html>\s*$", "", h, flags=re.I)
h = re.sub(r'<link rel="(icon|apple-touch-icon|manifest)"[^>]*>\n?', "", h)
h = re.sub(r'<meta charset="utf-8">\n?<meta name="viewport"[^>]*>\n?', "", h)
h = h.replace("<title>Crypto.M</title>", '<title>Crypto.M</title>\n<meta name="claude:viewport-fit-sides" content="cover">', 1)
css = (root / "css/app.css").read_text(encoding="utf-8")
h = h.replace('<link rel="stylesheet" href="css/app.css">', "<style>\n" + css + "\n</style>")
h = h.replace('three.min.js" defer></script>', 'three.min.js"></script>')
import base64, json
logos = {p.stem: "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode() for p in sorted((root / "img/coins").glob("*.png"))}
h = h.replace('<script src="js/i18n.js" defer></script>', "<script>window.COIN_LOGOS=" + json.dumps(logos) + ";</script>\n" + '<script src="js/i18n.js" defer></script>')
for f in ["i18n", "strategy", "data", "coin3d", "app"]:
    js = (root / f"js/{f}.js").read_text(encoding="utf-8").replace("</script", "<\\/script")
    h = h.replace(f'<script src="js/{f}.js" defer></script>', "<script>\n" + js + "\n</script>")
assert 'src="js/' not in h and 'href="css/' not in h
out.write_text(h.lstrip(), encoding="utf-8")
print(out, len(h))
