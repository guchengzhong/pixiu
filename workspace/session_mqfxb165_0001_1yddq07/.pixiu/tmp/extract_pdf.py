import fitz, sys
pdf_path = "uploads/SkillOpt_ Executive Strategy for Self-Evolving Agent Skills.pdf"
doc = fitz.open(pdf_path)
for i, page in enumerate(doc):
    text = page.get_text()
    print(f"\n--- Page {i+1} ---\n")
    print(text)
