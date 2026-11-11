# Database overview (partial audit log)

PostgreSQL via Prisma. Live gameplay stays in server memory; the DB records rooms, joins, rounds, answers, and imposter votes.

## Tables

| Table | Purpose |
|-------|---------|
| `Room` | One row per created room (`code`, `gameType`, `createdAt`). |
| `Player` | One row per lobby join (`name`, `ip`, session `playerId`, `isHost`). |
| `Round` | One row per started round. To'Davar: `roundNumber`, `matched`, `winningWord`, `winningGroups` (JSON), `endedAt`. |
| `Answer` | One word/answer per player per round (`text`, `normalizedText` for To'Davar). |
| `Vote` | Imposter-mode votes only (`voterId` / `targetId` → `Player.id`). |

## To'Davar sequence (analysis)

Join paths: `Room` → `Round` where `gameType = 'toDavar'` order by `roundNumber` → `Answer` per round.

```sql
SELECT r.code, ro."roundNumber", p.name, a.text, a."normalizedText", ro.matched
FROM "Room" r
JOIN "Round" ro ON ro."roomId" = r.id
JOIN "Answer" a ON a."roundId" = ro.id
JOIN "Player" p ON p.id = a."playerId"
WHERE r."gameType" = 'toDavar'
ORDER BY r.code, ro."roundNumber", p."joinedAt";
```

## Join keys

- `Player.roomId` = `Room.id`
- `Round.roomId` = `Room.id`
- `Answer.roundId` / `Vote.roundId` = `Round.id` (internal id, not `Round.roundId`)
