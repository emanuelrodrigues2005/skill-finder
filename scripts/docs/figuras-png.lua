-- Filtro Pandoc mínimo: troca o `src` de imagem terminado em `.pdf` por `.png`.
--
-- Motivo: o `main.tex` inclui as figuras vetoriais em PDF (Tectonic), mas o
-- Pandoc não embute PDF em DOCX — ele copiaria o arquivo para `word/media/` e o
-- Word não desenharia nada. O PNG equivalente é rasterizado pelo
-- `scripts/docs/pdf2png.ps1` a partir do mesmo PDF; o nome-base é o mesmo.
--
-- Escopo deliberadamente mínimo e auditável: percorre o documento e reescreve
-- uma string. Não lê ambiente, não abre arquivo, não executa processo, não
-- carrega módulo. A única API usada é a de string do Lua.

local function pdf_para_png(img)
  local src = img.src
  if src:sub(-4):lower() == ".pdf" then
    img.src = src:sub(1, -5) .. ".png"
  end
  return img
end

return {
  { Image = pdf_para_png },
}
