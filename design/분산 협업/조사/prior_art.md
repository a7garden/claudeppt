# 서버 없는 P2P 협업에서 「승인된 변경만 정본이 되는」 선행 사례

조사일 2026-11-27. 도구 호출 15회 한도 안에서 1차 자료(공식 문서 · 소스 코드 · 연구소 노트) 위주로 확인했다.
각 주장 뒤에 출처를 단다. 출처를 찾지 못한 것은 「Gaps」에 두었다.

## 1. Radicle (Heartwood): 정본 ref · sigrefs · 신원 문서 · 위임자 · Patch · 복제

### Takeaway
Radicle 은 ClaudePPT 가 원하는 구조와 가장 가깝다. 모든 노드가 각자 서명한 자기 ref 사본(namespace)을 가진다. 「정본」은 서버 위치가 아니라 **신원 문서에 적힌 위임자(delegate) 중 threshold 명 이상이 같은 커밋을 가리키는지를 각 노드가 스스로 계산한 결과**다. 신원 문서 변경은 별도 COB 로 다루고, 「현재 문서의 위임자 과반 수락」으로만 넘어간다. 약점은 셋이다. 갈라진 이력에는 정본이 멈춘다. 다중 기기는 「기기마다 위임자 하나」로 우회한다. 상시 켜진 seed 에 사실상 기댄다.

### Cited Findings
**신원 문서와 위임자**
- 신원 문서는 `refs/rad/id` 아래 JSON 이다. 이름 · 설명 · 기본 브랜치 · 위임자 DID 목록 · threshold 를 담는다. 같은 데이터가 같은 바이트가 되도록 Canonical JSON 으로 저장해 해시에 쓴다. — [Radicle Protocol Guide](https://radicle.dev/guides/protocol)
- 신원 문서는 `xyz.radicle.id` 타입의 COB(Collaborative Object)로 정의 · 관리된다. — [Radicle Protocol Guide](https://radicle.dev/guides/protocol)
- 노드 신원은 Ed25519 키 쌍이고, 공개키를 `did:key` DID 로 쓴다. 만드는 데 조정이나 개인 정보가 필요 없고 오프라인에서도 만든다. 키를 잃거나 탈취되면 새 노드 신원을 만들어야 한다. — [Radicle Protocol Guide](https://radicle.dev/guides/protocol)
- 위임자 상한(`MAX_DELEGATES`)은 255 다. 저장소를 만들 때는 만든 사람 혼자 위임자이고 threshold 는 1 이다. — [radicle crate doc.rs (docs.rs)](https://docs.rs/radicle/latest/src/radicle/identity/doc.rs.html)

**정본 ref (Canonical References, RIP-0004)**
- 정본 브랜치는 위치가 아니라 서명 threshold 로 동적으로 정한다. 2-of-3 이면 위임자 둘이 같은 커밋을 `master` 에 push 해야 정본이 된다. — [Radicle Protocol Guide](https://radicle.dev/guides/protocol)
- 2026-06-26 글: 정본 ref 의 권위는 「충분한 수의 신뢰받는 사람이 같은 커밋을 가리킴」이라는 합의에서 나온다. 노드는 신원 문서의 규칙과 각 위임자 namespace 사본을 보고 정본을 계산한다. 정족수에 닿으면 정본 ref 를 갱신하고 `CanonicalRefUpdated` 이벤트를 낸다. — [Canonical References in Radicle](https://radicle.garden/blog/canonical-references-in-radicle)
- 규칙은 신원 문서의 `xyz.radicle.crefs` 키에 둔다. 패턴(`refs/heads/…`, `refs/tags/*`)마다 `allow`(`"delegates"` 또는 DID 목록이고, 위임자가 아닌 DID 도 된다)와 `threshold`(1~255)를 준다. 여러 패턴이 맞으면 가장 구체적인 것이 이긴다. 기본 브랜치 규칙은 최상위 delegates/threshold 에서 자동으로 만든다. `rules` 는 갱신할 때마다 통째로 바뀐다. — [Canonical References in Radicle](https://radicle.garden/blog/canonical-references-in-radicle)
- 계산 방식은 Git 조상 관계를 존중한다. 투표자들이 한 줄의 이력 위에 있으면 지지가 충분한 가장 앞선 커밋이 이긴다(fast-forward 와 비슷하다). **진짜로 갈라지면 정족수가 없고 ref 는 이전 값에 머문다.** — [Canonical References in Radicle](https://radicle.garden/blog/canonical-references-in-radicle)
- 태그는 투표자들이 정확히 같은 Git 객체를 가리켜야 한다. 각자 따로 만든 annotated/signed 태그는 서로 다른 객체라 수렴하지 않는다. 그래서 한 사람이 태그를 만들고 나머지는 그 객체를 받아 지지한다. — [Canonical References in Radicle](https://radicle.garden/blog/canonical-references-in-radicle)
- 노드는 **자기 로컬 저장소에 있는 각 투표자 사본만** 보고 표를 센다. 위임자가 아닌 투표자는 follow 하거나 `--scope all` 로 복제해 두어야 보인다. — [Canonical References in Radicle](https://radicle.garden/blog/canonical-references-in-radicle)
- 신원 문서 갱신 검증(`verify_delegates`)은 정본 브랜치에 서명한 ref 를 가진 위임자 수를 센다. 그 수가 threshold 보다 적으면 갱신을 거부한다. — [radicle 0.24 doc/update.rs (docs.rs 검색 요약)](https://docs.rs/crate/radicle/0.24.0/source/src/identity/doc/update.rs)

**서명된 ref (sigrefs)**
- 노드는 자기 ref 가 바뀔 때마다 모든 ref 에 서명한다. 서명은 `refs/rad/sigrefs` 의 Git blob 에 `git show-ref` 꼴 목록과 함께 둔다. RID 와 사본만 있으면 누구나 최초 신원 문서에서 시작해 갱신을 인증할 수 있다. 검증 모델은 TUF(The Update Framework)에서 따왔다. — [Radicle Protocol Guide](https://radicle.dev/guides/protocol)

**신원 문서 갱신 · 위임자 추가 · 제거 (동시성 포함)**
- `rad id update` 는 제목 · 설명 · 변경(예: Bob 을 위임자로 추가하고 threshold 1→2)을 담은 새 revision 을 만든다. 위임자가 하나이고 threshold 가 1 이면 즉시 수락된다. 수락된 revision 은 고치거나 redact · reject 할 수 없다. — [rad-id.md 예제 (radicle-cli 0.21)](https://docs.rs/crate/radicle-cli/0.21.0/source/examples/rad-id.md)
- 위임자가 여럿이면 변경은 제안 상태로 남는다. 충분한 위임자가 `rad id accept <revision>` 을 해야 효력이 난다. **신원 문서 갱신은 정본 ref 규칙의 threshold 와 무관하게 늘 위임자 과반이 필요하다.** — [Canonical References in Radicle](https://radicle.garden/blog/canonical-references-in-radicle)
- revision 상태는 넷이다. Active(투표 중), Accepted(과반 수락, 이후 불변), Rejected(과반 거부, 불변), Stale(다른 revision 이 대신 수락되어 낡음). — [radicle 0.24 cob/identity.rs](https://docs.rs/crate/radicle/0.24.0/source/src/cob/identity.rs)
- 첫 revision 말고는 모두 parent 가 있어야 한다. Active revision 의 parent 는 늘 현재 revision 이다. parent 가 현재가 아니면 Stale 로 태어난다. accept/reject 는 `revision.parent == current` 를 단언한다. 즉 신원 변경은 **현재 문서 위의 선형 체인(compare-and-swap)** 이다. — [radicle 0.24 cob/identity.rs](https://docs.rs/crate/radicle/0.24.0/source/src/cob/identity.rs)
- 하나가 수락되면(`adopt()`) 나머지 Active revision 은 모두 Stale 이 된다(「Void all other active revisions」). 거부는 「현재 위임자 집합으로 더는 수락될 수 없을 때」 확정된다(`rejected > delegates - majority`). — [radicle 0.24 cob/identity.rs](https://docs.rs/crate/radicle/0.24.0/source/src/cob/identity.rs)
- 투표 권한은 **현재 revision 의 위임자 집합**으로 검사한다(`NonDelegateUnauthorized`). 서명도 현재(또는 parent) 문서로 검증한다. 동시 연산에서 생기는 `UnexpectedState` 는 치명적이지 않아 무시한다. 예를 들어 이미 수락된 revision 에 대한 동시 거부는 버려지고 Accepted 가 유지된다(`test_identity_reject_concurrent`: 「there was no way of knowing」). — [radicle 0.24 cob/identity.rs](https://docs.rs/crate/radicle/0.24.0/source/src/cob/identity.rs)
- (옛 radicle-link 명세) quorum 은 delegations 키의 과반(Q > D/2) 서명이다. — [Radicle Link Identities spec](https://github.com/radicle-dev/radicle-link/blob/next/docs/spec/identities.md)

**COB · Patch (PR 에 해당)**
- COB 는 `refs/cobs` 아래에 있고, 변경 하나가 Git 커밋 하나인 DAG 다. 복제본은 커밋 그래프의 합집합으로 합친다. 상태는 위상 순서로 reduce 해서 계산한다. 순서가 모호하면 merge 함수(예: 커밋 해시 정렬)로 정하거나 사용자에게 충돌을 보인다. 정의된 타입은 Issue · Patch · Identity 다. — [Radicle Protocol Guide](https://radicle.dev/guides/protocol)
- Patch 그래프는 신원 문서와 소스 커밋을 함께 참조한다. 그래서 patch 가 병합되었는지 판정할 수 있다. 리뷰 · 버전 · 토론을 지원한다. — [Radicle Protocol Guide](https://radicle.dev/guides/protocol)
- `git push rad HEAD:refs/patches` 로 patch 를 연다. 갱신은 force-push 이고 그때마다 불변 revision 이 생긴다. 작성자가 아니어도 새 revision 을 낼 수 있다. 위임자가 로컬에서 `git merge` 한 뒤 `git push rad main` 하면, revision 이 main 에 들어간 것을 보고 patch 를 병합됨으로 표시하고 정본 head 를 갱신한다. 사용자 가이드는 「고급 코드 리뷰 기능은 아직 없다」고 적는다. — [Radicle User Guide](https://radicle.dev/guides/user)

**복제 · gossip · seed**
- gossip 메시지는 셋이다. Node Announcement, Inventory Announcement(어디에 어떤 저장소가 있는지 알리고 라우팅 표를 만든다), Reference Announcement(관심 있는 노드에만 간다). 각 메시지에는 원 노드 ID · 서명 · 타임스탬프가 있다. 오래 꺼져 있던 노드에는 최근 메시지를 다시 보내 준다. 받은 노드는 seed 에 연결해 git fetch 로 객체를 협상한다. — [Radicle Protocol Guide](https://radicle.dev/guides/protocol)
- Seed 는 「지속적 접근을 주는 상시 켜진 기계」다. 초기에는 `iris`/`rosa.radicle.network` 가 공개 저장소를 seed 한다. 비공개 저장소는 협업자 사이 동기화를 중계할 신뢰 seed 가 필요하다(Tor 로 직접 연결하면 예외). — [Radicle User Guide](https://radicle.dev/guides/user)
- 비공개 저장소는 신원 문서 `visibility: private` + `allow` DID 목록으로 정한다. 목록 안 노드만 복제할 수 있다. **저장 데이터는 암호화하지 않는다.** — [Radicle Protocol Guide](https://radicle.dev/guides/protocol)
- 프로토콜 가이드의 전송 암호화 · 프라이버시 절은 「심각한」 네트워크 프로토콜 취약점 때문에 내려가 있다(조사 시점). — [Radicle Protocol Guide](https://radicle.dev/guides/protocol)

**다중 기기 · 알려진 불편**
- 「기기마다 자기 DID 가 있어야 한다」. 여러 기기에서 push 하려면 기기 DID 를 각각 위임자로 더한다(`rad id update`). 키 분실 시 복구 절차는 가이드에 없다(패스프레이즈 보호만 있다). — [Radicle User Guide](https://radicle.dev/guides/user)
- 2026-02 사용자 후기에 적힌 불편은 이렇다. NID/DID 구분이 헷갈린다. 다중 기기는 「기기마다 키/위임자 하나가 더 낫다」. 정본 ref 는 「JSON 안의 또 다른 ACL 언어」라 「흥미롭고도 무섭다」. 규칙을 손으로 고쳐야 한다. `rad init` 이 main 만 복사한다. 저장소가 노드 저장소에 따로 중복된다. UPnP 가 없다. — [Notes on radicle (2026-02-08)](https://equalsraf.codeberg.page/articles/2026-02-08-notes-on-radicle.html)

### Inferences
- **ClaudePPT 에 그대로 옮길 만한 것**: (a) 사람마다 자기 서명 ref 목록(sigrefs)을 낸다. (b) 「정본 = 승인 권한자 k 명이 가리키는 공통 조상 위 가장 앞선 커밋」을 각 피어가 자기 로컬 사본만으로 계산한다. (c) 권한 문서는 별도 체인으로 두고 「parent = 현재」 CAS 와 과반 수락으로만 넘긴다. 이렇게 하면 어느 피어가 들고 와도 같은 결론이 나온다.
- threshold=1 이면 「승인자 아무나 한 명이 main 을 앞으로 민다」가 되어 PR 승인과 같다. 이때 두 승인자가 분할 상태에서 서로 다른 커밋을 승인하면 Radicle 규칙상 둘 다 정본이 될 수 있는데(각각 1표), 실제로 어떻게 처리하는지는 확인하지 못했다(Gaps). ClaudePPT 는 이 경우의 결정 규칙(예: 「둘 다 승인 대기 → 다음 승인이 merge 커밋으로 합친다」 또는 결정적 타이브레이크)을 따로 정해야 한다.
- 「갈라지면 정본이 이전 값에 머문다」는 안전 쪽(fail-safe) 선택이다. 진행이 멈춘 것을 사용자에게 보여 주는 UI 가 필요하다.
- 동시 거부를 무시하는 처리(이미 수락된 쪽이 이긴다)는 「먼저 보인 수락이 이긴다」에 가깝다. 노드마다 도착 순서가 다르면 해석이 달라질 수 있는지 검토해야 한다(코드 주석만 봤다).

### Gaps
- threshold=1 에서 위임자 둘이 서로 다른(조상 관계 없는) 커밋을 가리킬 때 정본 계산 결과를 1차 자료로 확인하지 못했다. 「진짜로 갈라지면 정족수 없음」 문장이 threshold=1 에도 해당하는지는 분명하지 않다.
- 위임자 제거 뒤, 제거된 위임자가 오프라인에서 계속 서명한 ref 를 어떻게 다루는지(과거 문서 기준이냐 현재 문서 기준이냐)는 소스를 끝까지 보지 못했다.
- RIP-0002(Identity) 원문은 찾지 못했다.

## 2. git-bug 등 git 내장 분산 이슈 추적기

### Takeaway
git-bug 는 상태가 아니라 **연산 로그(OperationPack)를 git 커밋 체인으로 저장**한다. 동시 편집은 DAG 로 합친다. 순서는 Lamport clock 으로 정하고 동점이면 pack ID 사전순으로 정한다. 구조는 단순하고 git remote 로 그냥 동기화되지만, 권한 · 승인 개념은 없다.

### Cited Findings
- 엔티티(버그 · 작성자 · 설정)는 편집 연산 열로 저장하고, 재생해서 현재 상태를 만든다. 연산에는 타입 · 작성자 참조 · 타임스탬프 · 데이터 · 무작위 nonce 가 있고, ID 는 데이터의 해시다. — [git-bug data model](https://github.com/git-bug/git-bug/blob/master/doc/design/data-model.md)
- 한 편집 세션의 연산은 OperationPack(git blob 의 JSON 배열)으로 묶는다. 트리(`ops`, `media`)와 커밋 체인을 이루고 `refs/<namespace>/<id>` 로 드러나 일반 git remote 로 동기화된다. — [git-bug data model](https://github.com/git-bug/git-bug/blob/master/doc/design/data-model.md)
- 벽시계 시간은 틀리거나 조작될 수 있어 표시용으로만 쓴다. Lamport clock 을 트리 항목 이름(`create-clock-N`, `edit-clock-N`)에 둔다. clock 이 DAG 와 어긋나는 커밋은 버린다. 정렬은 Lamport, 동점은 pack ID 사전순이다. 이 동점 규칙은 「의미는 별로 없지만 치우침이 없고 악용하기 어렵다」. — [git-bug data model](https://github.com/git-bug/git-bug/blob/master/doc/design/data-model.md)
- 「서명된 작성자 기록」「서명된 커밋」을 언급하지만 키 관리 방식은 이 문서에 없다. — [git-bug data model](https://github.com/git-bug/git-bug/blob/master/doc/design/data-model.md)

### Inferences
- ClaudePPT 의 「제안(PR) · 의견 · 승인 기록」을 덱 저장소 안 별도 ref namespace 에 연산 로그로 두면 덱 git 과 같은 경로로 iroh 위에서 옮길 수 있다. Radicle COB 도 같은 발상이다.
- 「clock 이 DAG 와 어긋나면 버림」 규칙은 백데이트 공격을 일부 막는 값싼 검증이다.

### Gaps
- git-bug 신원(identity) 엔티티의 버전 관리 · 키 회전 문서는 이번에 열지 못했다.

## 3. Ink & Switch: Upwelling · Patchwork · Keyhive

### Takeaway
Upwelling 과 Patchwork 는 「초안/브랜치 → 검토 → main 병합」 UX 의 선례다. 둘 다 **승인을 소프트웨어로 강제하지 않는다**(아무나 병합하고, 승인은 사회적 관례에 맡긴다). Upwelling 은 서버나 커스텀 CRDT 없이는 동시 병합을 막을 수 없다고 명시했다. Keyhive 는 서버 없는 접근 제어(그룹 · 위임 · 취소 · E2EE)의 가장 진척된 연구다. 권한은 「인증서 집합」에서 순서와 무관하게 계산하고, 취소는 소급(retrocausal)한다. 다만 관리자끼리의 상호 취소 같은 동시 취소 처리는 아직 미뤄 두었다. pre-alpha 이고 감사받지 않았다.

### Cited Findings
**Upwelling (2023-03)**
- 모든 편집은 layer 안에서 일어난다. 병합 안 된 layer 는 「draft」이고 목적을 적은 제목이 있다. 병합된 layer 는 선형 이력 「stack」이 된다. — [Upwelling](https://www.inkandswitch.com/upwelling/)
- 한 draft 가 병합되면 그 변경을 열린 다른 draft 들에 rebase 한다(floating drafts). 작성자는 알림을 받지만 자기 때에 반영하므로, 충돌이 병합 전에 드러난다. — [Upwelling](https://www.inkandswitch.com/upwelling/)
- 권한은 단순하다. draft 는 혼자만 보거나 공유하며, 링크가 있으면 누구나 보고 고치고 병합한다. **편집자 승인 같은 절차는 소프트웨어가 강제하지 않는 사회적 관례로 둔다.** 이력과 기여자 표시가 전부 남아 실수를 추적하고 되돌린다. 뉴스룸용 엄격한 통제는 향후 과제다. — [Upwelling](https://www.inkandswitch.com/upwelling/)
- 보고된 문제는 다음과 같다. 실시간 협업이 감시받는 느낌을 준다(fishbowl effect). 자동 병합이 뒤섞인 문장을 만든다. 다른 곳에서 문단이 지워지면 고아 삽입이 남는다. 의미 충돌은 사람이 봐야 한다. 작은 draft 와 소통으로 피하는 편이 낫다. **동시 병합을 막지 않았고, 막으려면 서버나 커스텀 CRDT 가 필요하다.** 전체 이력 보존은 취재원 보호 같은 보안 작업에 문제가 된다. — [Upwelling](https://www.inkandswitch.com/upwelling/)

**Patchwork (2024 version control 노트)**
- 핵심은 빠르고 의례 없는 브랜치 생성 · 전환 · 병합 · 삭제다. 기본 편집은 main 에서 하므로 브랜치를 몰라도 공동 편집할 수 있다. 연구진은 노트 글의 수정 제안에 브랜치를 쓴다. — [Patchwork notebook 06 (branches)](https://www.inkandswitch.com/patchwork/notebook/2024-version-control/06/)
- 뒤 요약에서 꼽은 주요 기능은 가벼운 브랜치 · diff 시각화 · 채팅형 이력 인터페이스다. 브랜치와 main 의 관계를 보여 줄 공간 은유는 열린 과제다. — [Patchwork notebook 10](https://www.inkandswitch.com/patchwork/notebook/10/), [Universal version control](https://www.inkandswitch.com/universal-version-control/)

**Keyhive**
- 주체는 개인(Ed25519 공개키)과 그룹이다. 문서도 그룹이다. **사람은 자기 기기들을 멤버로 둔 그룹**이고, 키 회전은 새 기기 키를 더하고 옛 키를 빼는 것이다. 그룹은 중첩된다. — [Keyhive notebook](https://www.inkandswitch.com/keyhive/notebook/)
- convergent capabilities(concaps)는 CRDT 상태를 지닌 capability 다. 네트워크 분할에서도 동작하면서 취소를 지원한다. 문서는 공개키로 식별하고 다른 키에 권한을 위임한다(자기 인증). — [Keyhive 01](https://www.inkandswitch.com/keyhive/notebook/01/)
- 권한 등급은 Admin · Edit · Read · Relay 다. Relay 는 복호화 없이 암호문을 가져오고 저장만 한다. 위임은 위임자가 가진 것 이상을 줄 수 없다(가장 좁은 고리가 사슬을 제한한다). — [Keyhive 07 Certflow](https://www.inkandswitch.com/keyhive/notebook/07/)
- 취소도 위임처럼 서명된 진술이다. 취소된 위임에 기댄 하위 권한은 다른 경로가 없으면 모두 잃는다. 취소는 「retrocausal」(과거 위임과 그에 기댄 것을 무효화)이고 아무것도 지우지 않는다. 인증서 집합은 늘어나기만 한다. **권한은 도착 순서가 아니라 인증서 집합으로 정한다.** 인증서는 늘 발급자에게 권한을 준 위임보다 인과적으로 뒤에 온다. — [Keyhive 07](https://www.inkandswitch.com/keyhive/notebook/07/), [Keyhive 08 Rain diagrams](https://www.inkandswitch.com/keyhive/notebook/08/)
- 동시 취소(관리자 둘이 서로 취소)와 「백데이트」 연산은 어려운 사례로 꼽혔고, 자세한 처리는 뒤 글로 미뤘다. — [Keyhive 01](https://www.inkandswitch.com/keyhive/notebook/01/)
- 총순서를 정할 중앙 서버 없이 인과 순서만 쓴다. 합의(consensus)는 local-first 목표와 충돌해 최후 수단이다. — [Keyhive 06](https://www.inkandswitch.com/keyhive/notebook/06/)
- E2EE 는 이렇게 한다. BeeKEM(서버 없이 인과 순서만 쓰는 CGKA)은 동시 갱신을 「conflict keys」로 남겼다가 인과적으로 뒤의 연산이 해소한다. 보안 매개변수 κ 로 전방 비밀성과 분할 내성을 맞바꾼다. 문서는 청크 단위로 압축 · 암호화한다. 청크 키를 인과적 선행 청크에 잇기 때문에, 전방 비밀성을 포기하는 대신 전체 이력을 볼 수 있다. — [Keyhive 02](https://www.inkandswitch.com/keyhive/notebook/02/), [Keyhive 06](https://www.inkandswitch.com/keyhive/notebook/06/)
- 동기화(Beelay)에서는 메시지에 audience · timestamp 를 넣어 서명해 중간자 · 재전송을 막는다. 멤버십 그래프와 문서 상태는 RIBLT 로 맞춘다. 「sedimentree」로 암호화된 이력을 압축 전송한다. — [Keyhive 05](https://www.inkandswitch.com/keyhive/notebook/05/)
- 신원 바인딩 · 이름 찾기 · 사용자 검증은 범위 밖이다. 문서 일부 접근 제어는 목표로만 적혀 있고 구체적 메커니즘은 노트에 없다. — [Keyhive 01](https://www.inkandswitch.com/keyhive/notebook/01/), [Keyhive notebook](https://www.inkandswitch.com/keyhive/notebook/)
- 상태: 2025-03-10 pre-alpha(`keyhive_core`, `beelay-core`, `keyhive_wasm`)로, 운영용이 아니며 보안 감사도 받지 않았다. 2026-07 BeeKEM 보안 형식화 글, 2026-10/11 Certflow · Rain diagram 글이 나왔다. — [Keyhive 04](https://www.inkandswitch.com/keyhive/notebook/04/), [Keyhive notebook](https://www.inkandswitch.com/keyhive/notebook/)

### Inferences
- 「승인 전 main 병합 금지」는 Upwelling · Patchwork 에 없는 기능이다. 그쪽 경험에서 가져올 것은 UX 다. draft 마다 목적 제목을 단다. main 이 앞서면 열린 draft 들에 rebase 를 알린다. 작은 draft 를 권한다.
- Keyhive 의 「사람 = 기기 그룹」 모델은 ClaudePPT 의 「앱마다 ed25519 키」와 바로 맞는다. 승인 권한은 사람(그룹)에 주고 기기 키는 그 그룹 멤버로 둔다. 기기를 잃으면 다른 기기가 그 키만 뺀다.
- 「권한은 인증서 집합에서 순서와 무관하게 계산」 + 「취소는 소급」을 승인에 적용하면 이렇게 된다. 취소된 승인자의 서명은 그 취소가 인과적으로 앞서지 않은 승인에 한해서만 유효하다. 다만 오프라인 서명은 인과 관계를 주장하기 쉬워(parent 를 옛 것으로) 백데이트 문제가 남는다. Keyhive 도 미해결로 둔 부분이다.
- 일부 쪽만 보는 권한(page 단위 가시성)은 Keyhive 에서도 연구 단계다. 현실적 선택은 둘이다. git 저장소 하나에 같이 담으면 「복제되는 피어는 전부 본다」(Radicle private 처럼). 쪽별로 숨기려면 쪽별 암호화가 필요하고, 그러면 git diff · 병합이 어려워진다.

### Gaps
- Patchwork-26 등 2025~2026 최신 Patchwork 글은 열지 못했다. 브랜치 권한 · 리뷰 강제가 생겼는지는 확인하지 못했다.
- Keyhive 의 동시 상호 취소 해소 규칙을 담은 글은 찾지 못했다(노트 01 기준 「뒤로 미룸」).

## 4. 다른 체계: Matrix state resolution · 로컬 우선 ACL 연구 · gitsign 등

### Takeaway
분할 중 권한 변경을 결정적으로 푸는 가장 성숙한 운영 사례는 Matrix state resolution v2 다. 권한 이벤트를 먼저, 보낸 사람 권한 높은 순 → 타임스탬프 → ID 순으로 정렬해 차례로 auth-check 한다. 학계 쪽(Kleppmann, Jacob & Hartenstein)은 「ACL 자체를 Byzantine 내성 CRDT 로」 만드는 방향이다. 동등 권한자 사이 상호 취소가 핵심 미해결 문제로 꼽힌다. gitsign 은 중앙 인프라(Fulcio/Rekor)에 기대므로 이 요구에 맞지 않는다.

### Cited Findings
**Matrix state resolution v2**
- 권한 이벤트(power events)는 `m.room.power_levels`, `m.room.join_rules`, 그리고 남을 내보내거나 차단하는 `m.room.member` 다. 즉 「누군가의 권한을 없앨 수 있는」 이벤트다. — [Matrix spec rooms v2](https://spec.matrix.org/v1.16/rooms/v2/)
- 상태 집합들 사이에서 값이 다른 키를 충돌 상태로 모은다. 모든 auth chain 에 공통이지 않은 이벤트(auth difference)를 더한다. 권한 이벤트는 reverse topological power ordering(보낸 사람 power 높은 순 → `origin_server_ts` 이른 순 → `event_id`)으로 정렬해, 충돌 없는 상태에서 출발해 하나씩 반복 auth-check 한다. 나머지는 mainline ordering(power_levels 이벤트 사슬 위치 → 시간 → ID)으로 정렬해 다시 auth-check 한다. — [Matrix spec rooms v2](https://spec.matrix.org/v1.16/rooms/v2/)
- auth 에 실패해 거부된 이벤트도 알고리즘에는 쓴다. 서버 간 수렴을 돕지만 공격 위험이 있다는 절충을 명시한다. 서버들이 상태를 다르게 볼 수 있고 room 이 갈라질 수 있다고 적는다. — [Matrix spec rooms v2](https://spec.matrix.org/v1.16/rooms/v2/)

**로컬 우선 접근 제어 연구**
- Kleppmann PaPoC 2025 기조연설(2025-03-31)의 요지는 이렇다. CRDT 는 누가 상태를 바꿀 수 있는지를 다루지 않았다. 서버 없이 접근 제어하려면 권한자 집합을 담은 복제 자료구조가 필요하고, 이 ACL 자체가 악의적 조작에 견디는 CRDT 여야 한다. 슬라이드에 「ACL CRDT 논문 작업 중」이라고 적혀 있다(검색 요약 기준). — [Kleppmann PaPoC 2025 keynote](https://martin.kleppmann.com/2025/03/31/papoc-keynote-byzantine.html), [slides](https://speakerdeck.com/ept/byzantine-eventual-consistency-and-local-first-access-control)
- Jacob & Hartenstein(ACSAC 2024)은 중앙집중 관행을 깨는 「eventually consistent access control(ECAC)」을 연구했다. 2026 arXiv 예비 논문(Jacob & Stuber, 2604.23560)은 Byzantine 결함 아래 로컬 우선 접근 제어를 형식 검증한다. 이 논문은 「동등 권한자 사이 상호 취소 해소」를 Kleppmann 쪽 주제로 두고 자기 범위 밖이라고 적는다. — [arXiv 2604.23560](https://arxiv.org/html/2604.23560v1)
- 그 기반은 Kleppmann 2022 「Making CRDTs Byzantine Fault Tolerant」(PaPoC 2022)다. — [Kleppmann PaPoC 2025 keynote 슬라이드 참고문헌(검색 요약)](https://speakerdeck.com/ept/byzantine-eventual-consistency-and-local-first-access-control)

**sigstore gitsign**
- 기본(온라인) 모드는 커밋 SHA 와 인증서에 맞는 Rekor 항목을 검색하느라 인터넷이 필요하다. 오프라인 모드(`rekorMode=offline`)는 검증 자료를 커밋 안에 넣지만 서명 때는 여전히 Rekor(공개 투명성 로그)에 기록한다. 기본으로 공개 Rekor 에 올라가 서명 인증서 정보가 공개된다. 온라인 검증 중 잘못된 Rekor 항목을 고르는 취약점 권고가 있었다. — [gitsign verification.md](https://sources.debian.org/src/gitsign/0.13.0-4/docs/verification.md), [gitsign README](https://raw.githubusercontent.com/sigstore/gitsign/main/README.md), [GitLab advisory](https://advisories.gitlab.com/pkg/golang/github.com/sigstore/gitsign)

### Inferences
- **분할 중 두 승인자의 동시 승인**: Matrix 식으로 옮기면 「승인 이벤트를 (승인자 권한 순위, 승인 대상 커밋의 위상 깊이, 서명 해시) 같은 결정적 키로 정렬해 차례로 적용」하는 규칙이 된다. 그러면 모든 피어가 같은 main 을 고른다. 진 쪽 커밋은 버리지 않고 「승인됐지만 병합 대기」로 남겨 다음 승인자가 merge 커밋으로 합치게 하면 Radicle 의 「ancestry 존중」과도 맞는다.
- **취소 경쟁(취소된 승인자가 오프라인에서 서명)**: 선택지는 셋이다. (a) Radicle 처럼 권한 문서를 「parent = 현재」 선형 체인으로 두고, 승인 서명이 참조한 권한 문서 판이 낡았으면 무효로 한다. (b) Keyhive 처럼 취소를 소급해 취소와 인과적으로 동시인 서명도 무효로 한다. (c) Matrix 처럼 power 순위로 정렬해 높은 권한자의 취소를 먼저 적용한다. 셋 다 「백데이트한 서명」은 막지 못하므로, 승인에 「내가 본 권한 문서 판 해시」를 넣게 하는 것이 최소 방어다.
- **키 분실 복구**: Radicle 은 「새 노드 신원」 외 절차가 없다. Keyhive 는 「사람 = 기기 그룹」이라 남은 기기가 잃은 키를 뺀다. 둘을 합치면 이렇게 권할 수 있다. 사람마다 기기 2개 이상 또는 종이 복구 키를 두고, 모든 기기를 잃으면 다른 승인자 과반이 권한 문서에서 그 사람을 새 키로 바꾼다(Radicle 식 과반 revision).
- gitsign 은 중앙 CA 와 투명성 로그가 전제라 「상시 서버 없음」 조건과 맞지 않는다. 대신 git 의 SSH/ed25519 서명 커밋(`gpg.format=ssh`)이 기존 ed25519 키와 맞을 가능성이 높다(확인하지 않았다).

### Gaps
- **Pijul, Fossil sync, Secure Scuttlebutt, Peergos, Automerge/Yjs 의 접근 제어, git signed push(push certificate)** 는 도구 호출 한도 때문에 1차 자료를 확인하지 못했다. 필요하면 따로 조사한다.
- Kleppmann 의 상호 취소 해소 방식(예: 연공서열 · 둘 다 취소)의 구체 내용은 슬라이드 본문을 읽지 못해 확인하지 못했다.
- Matrix 의 「state reset」 실사례와 v2.1 개정(있다면) 여부는 이 페이지에 없었다.
- 2025 Jacob & Hartenstein 후속 논문의 제목 · 내용은 확인하지 못했다.
