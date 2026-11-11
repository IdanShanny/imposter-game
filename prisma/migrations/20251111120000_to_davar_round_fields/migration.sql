-- AlterTable
ALTER TABLE "Round" ADD COLUMN "roundNumber" INTEGER,
ADD COLUMN "matched" BOOLEAN,
ADD COLUMN "winningWord" TEXT;

-- AlterTable
ALTER TABLE "Answer" ADD COLUMN "normalizedText" TEXT;
