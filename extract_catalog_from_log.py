import re
import json
from bs4 import BeautifulSoup

log_path = "/home/momen/.gemini/antigravity/brain/9ba17146-8842-4a7f-ba90-81deb6a3df1b/.system_generated/logs/overview.txt"

with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
    text = f.read()

user_requests = re.findall(r"<USER_REQUEST>(.*?)</USER_REQUEST>", text, re.DOTALL)

target_html = None
for req in reversed(user_requests):
    if "<div" in req:
        target_html = req
        break

if not target_html:
    print("Could not find HTML in <USER_REQUEST>")
    exit(1)

target_html = target_html.replace('\\"', '"').replace('\\n', '\n')
soup = BeautifulSoup(target_html, "html.parser")

folders = []
folders_set = set(["Uncategorized"])
articles = []

def clean_title(t):
    if not t:
        return ""
    return t.replace("\u00a0", " ").strip()

current_folder = "Uncategorized"

# Find all span elements with text
all_spans = soup.find_all("span")

for span in all_spans:
    title = clean_title(span.get_text())
    if not title or len(title) > 150 or "\n" in title:
        continue
    
    # Check parent row element html
    parent = span.find_parent("div", class_=lambda c: c and "whitespace-nowrap" in c) or span.find_parent("button") or span.parent
    if not parent:
        continue
        
    parent_html = str(parent).lower()
    
    is_folder = "folder" in parent_html
    is_article = "newspaper" in parent_html
    
    if is_folder and not is_article:
        current_folder = title
        if current_folder not in folders_set:
            folders.append(current_folder)
            folders_set.add(current_folder)
    elif is_article:
        if not any(a["title"].lower() == title.lower() for a in articles):
            articles.append({
                "id": f"master-{len(articles)+1:04d}",
                "title": title,
                "folderName": current_folder,
                "fetched": False,
                "markdown": None
            })

print(f"🎉 SUCCESS! Extracted {len(folders)} Folders and {len(articles)} Total Pending Articles!")

catalog = {
    "folders": ["Uncategorized"] + folders,
    "articles": articles
}

with open("library_data/library.json", "w", encoding="utf-8") as f:
    json.dump(catalog, f, indent=2, ensure_ascii=False)

print("Saved cleanly to library_data/library.json!")
