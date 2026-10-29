-- Miniatura (WebP leve) das imagens de conversa: o balão carrega esta e só o clique abre a original. Null = sem miniatura
-- (imagem anterior a esta migração ou que não pôde ser reduzida): o balão cai na original.
ALTER TABLE "media_files" ADD COLUMN "thumb_key" text;
