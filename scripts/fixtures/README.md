# 판정 회귀 픽스처

`judge-cases.json` 은 **실제 Jira 응답을 녹화한 것**입니다.

## 무엇에 쓰나

판정 로직을 고칠 때 답이 달라졌는지 봅니다.

- 판정이 틀려도 **오류가 안 납니다** — 틀린 사람에게 알림이 갈 뿐입니다
- 그래서 테스트 말고는 알 방법이 없습니다
- `via` · `classification` · `name` · `reason` 네 가지를 고정합니다
- `reason` 까지 고정하는 이유: 그 문장이 그대로 Slack 에 나갑니다

## 다시 녹화하기

```bash
set -a && . ./.env.local && set +a
npx tsx scripts/qa-router.record.mts
```

필요한 것: `IGNITE_JIRA_EMAIL`, `IGNITE_JIRA_API_TOKEN`
바꿀 수 있는 것: `QA_ROUTER_FILTER_ID` (기본 12571)

**언제 다시 녹화하나**

- 판정을 **일부러** 바꿨을 때. 이때는 diff 를 눈으로 확인하고 녹화합니다
- 표본을 넓히고 싶을 때 (`SAMPLE` 상수)

**언제 녹화하면 안 되나**

- 테스트가 깨졌는데 이유를 모를 때. 녹화는 그 변화를 **정답으로 만들어
  버립니다** — 회귀를 지우는 것과 같습니다

## 지금 표본의 한계

| 단계 | 건수 |
|---|---|
| `ref_owner` | 36 |
| `assigned` | 3 |
| `epic` | 1 |
| `siblings` | **0** |

`siblings` 가 0건인 건 이 프로젝트에서 그 단계가 거의 안 쓰이기 때문입니다.
바꿔 말하면 **회귀 테스트가 그 단계를 못 지킵니다.** 그 단계를 고칠 때는
따로 확인해야 합니다.

## 왜 이렇게 작나 (909KB)

녹화할 때 판정이 안 읽는 필드를 덜어냅니다 — `self` `expand` `avatarUrls`
`emailAddress` 등. 그대로 두면 2.3MB 였고, 그 크기에서는 사람이 diff 를
읽을 수 없습니다. 골든 파일은 읽을 수 있어야 값어치가 있습니다.
