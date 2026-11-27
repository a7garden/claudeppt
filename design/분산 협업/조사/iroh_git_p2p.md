# iroh 생태계와 git 저장소 P2P 전송 (서버 없는 데스크톱 협업 설계용)

조사일 2026-11-27. 기준: iroh 1.x (1.0 은 2026-06-15 출시, 사용 중인 판은 1.5). 그 이전 정보는 「옛 정보」로 표시했다.
참고: docs.rs 의 일부 페이지 요약에는 iroh 1.0.3 이 최신으로 나오지만, iroh-gossip 0.103 이 `iroh ^1.4` 를 요구하므로 1.4 이상이 이미 나와 있다. 판 번호는 docs.rs 에서 직접 다시 볼 것.

## 1. n0 공개 릴레이: 사용 한도 · 용도 · SLA · 약관 · 유료 상품 (2026)

### Takeaway
n0 공개 릴레이는 공식적으로 「개발 · 취미용」이고 SLA 가 없으며 한도는 공개하지 않은 채 수시로 조정한다. 운영용으로는 유료 Shared relay(Pro $19/월, 5 MB/s, 100 GB 포함)나 Dedicated/Managed relay를 권한다. 다만 연결 데이터의 대부분은 hole punching 이 된 뒤 직접 경로로 흐르고, 유료 릴레이도 릴레이를 거친 트래픽만 과금한다.

### Cited Findings
- 공개 릴레이 문서: 「Public relays are suitable for development and hobby use only」, 「For production, use managed relays」. 인증 없이 모든 iroh endpoint 에 열려 있고 무료다. — [docs.iroh.computer / public relays](https://docs.iroh.computer/iroh-services/relays/public)
- 같은 문서: 「Traffic is rate-limited to prevent abuse」(수치 비공개), 「No SLA or uptime guarantee」, 「Only the latest stable release of iroh is officially supported」, 「No version locking」, n0 는 옛 iroh 판의 지원을 언제든 뺄 수 있다. 악성 행위가 보이면 IP · 사용자를 차단할 수 있다. 종단간 암호화는 되지만 「민감 · 기밀 데이터에는 공개 릴레이를 권하지 않는다」. 별도 약관(ToS) 절은 없다. — [public relays](https://docs.iroh.computer/iroh-services/relays/public)
- 한도는 공개하지 않고 필요할 때마다 조정한다. 연결 단위로 걸리므로 한 클라이언트가 한도에 걸려도 같은 릴레이의 다른 클라이언트에는 영향이 없다. — [rate limiting](https://docs.iroh.computer/relays/rate-limiting)
- iroh 1.0 공지: 지난 30일 동안 공개 릴레이(주로 「n0」 preset)에서 2억 개 넘는 endpoint 가 만들어졌다. 릴레이는 새 판 출시 뒤 약 24시간 안에 갱신하고, 와이어가 깨지는 변경에는 새 URL 을 쓴다. 릴레이를 거친 트래픽은 한도가 걸리고 그 한도는 언제든 바뀔 수 있다. 공개 릴레이 종료일: v1.0 은 EOL 까지, v0.35x 는 2026-12-31, v0.9x · 1.0.0-rcX 는 2026-09-30. — [Iroh 1.0 - Dial Keys, not IPs](https://iroh.computer/blog/v1)
- 같은 공지: 「It's normal to see 95% of data transferred in a connection pass directly between devices」. 측정 연구가 아니라 「흔히 보는」 값으로 제시했다. — [iroh blog v1](https://iroh.computer/blog/v1)
- Shared relay(유료, 인증): 5 MB/s 한도. Pro 플랜 $19/월에 4개 지역 릴레이, 동시 연결 10,000 포함(추가 endpoint 당 월 $0.003), 릴레이 egress 월 100 GB 포함, 초과분 GB 당 $0.09. **직접 P2P 트래픽은 egress 에 세지 않는다.** API key 로 토큰을 만들고, 토큰은 Endpoint ID 에 묶인다. 30일 무료 체험이 있다. 무료 프로젝트는 릴레이 URL 을 빼면 n0 공개 릴레이를 쓴다. — [shared relays](https://docs.iroh.computer/iroh-services/relays/shared)
- Dedicated/Managed relay: 나만 쓰고, 기본으로 인증하며, 공유 트래픽도 한도도 없다. 운영에는 지역이 다른 릴레이를 최소 2개 두라고 권한다. — [managed relays](https://docs.iroh.computer/iroh-services/relays/managed), [dedicated infrastructure](https://docs.iroh.computer/deployment/dedicated-infrastructure)
- 말이 다른 출처: 예전 n0 페이지는 「성능이 괜찮으면 공개 릴레이로 운영 시스템을 돌려도 된다」고 했다. 현재 문서는 운영에 쓰지 말라는 쪽이다(옛 정보). — [iroh FAQ (old)](https://www.iroh.computer/docs/faq), [public relays (current)](https://docs.iroh.computer/iroh-services/relays/public)

### Inferences
- 덱 하나는 수 MB에서 수십 MB 다. 공개 릴레이로 중계되는 최악의 경우에도 첫 복제 한 번은 대개 견딜 만하다고 본다. 다만 한도 수치가 공개되지 않아 몇 초가 걸릴지는 확정할 수 없다. 그 뒤의 증분 fetch 는 KB 단위라 릴레이 한도가 문제 될 일이 적다.
- 「공개 릴레이 + 직접 연결 우선」은 작은 팀 데스크톱 앱에 현실적인 기본값이다. 다만 SLA 가 없고 「최신 안정판만 지원」이므로, 앱이 iroh 판을 오래 묵히면 릴레이에서 밀려날 위험이 있다. iroh 갱신을 정기 작업으로 둘 것.
- 사용자 설정에서 「Shared relay API key」나 「사용자 릴레이 URL」로 바꿀 수 있게 열어 두면, 앞으로 유료로 옮기는 길이 막히지 않는다.

### Gaps
- 공개 릴레이의 실제 대역폭 · 연결당 한도 수치는 공개되지 않았다(n0 가 일부러 비공개).
- 공개 릴레이 전용 약관(ToS) 문서는 찾지 못했다.

## 2. 릴레이 직접 운영 · 릴레이/디스커버리 없이 가기 · hole punching 성공률

### Takeaway
iroh-relay 직접 운영은 TOML 하나와 80/443 포트, Let's Encrypt 로 되지만 늘 켜진 공인 서버가 필요하다. 그래서 이 사용자에게는 맞지 않는다. 같은 LAN 이면 mDNS 계열 address lookup 으로 릴레이 · DNS 없이 붙을 수 있다. 인터넷 너머에서 처음 만날 때는 사실상 릴레이(최소한 hole punching 조정용)와 pkarr/DNS 가 필요하다. 직접 연결 성공률은 n0 자체 주장으로 「약 10 중 9」이고, 독립 측정은 없다(libp2p 독립 측정은 약 70%).

### Cited Findings
- 직접 운영 최소 설정: `http_bind_addr = "[::]:80"`, `https_bind_addr = "[::]:443"`, `cert_mode = "LetsEncrypt"`, `hostname`, `cert_dir`, `contact`. `/etc/iroh-relay/config.toml` 로 두고 `iroh-relay -c config.toml` 로 띄운다. 배포는 GitHub 릴리스 바이너리 또는 Docker `n0computer/iroh-relay`. 확인은 `/healthz`. 「Documentation of all possible configuration options for the relay is not published currently」 — 설정 전체는 소스(`iroh-relay/src/main.rs`)를 봐야 한다. — [self-hosted relays](https://docs.iroh.computer/iroh-services/relays/self-hosted)
- 릴레이는 상태가 없다(DB 없음). 클라이언트는 여러 릴레이를 자동으로 시도하고 하나가 죽으면 다른 것으로 넘어간다. — [dedicated infrastructure](https://docs.iroh.computer/deployment/dedicated-infrastructure)
- 직접 운영할 때는 공개 릴레이처럼 rate limiting 을 설정하라고 권한다. — [rate limiting](https://docs.iroh.computer/relays/rate-limiting)
- 로컬 디스커버리(1.x): 선택 기능이고 기본으로 켜져 있지 않다. 두 crate 가 있다. `iroh-mdns-address-lookup` 은 swarm-discovery(mDNS 변형)를 쓰고, `iroh-mdns-peer-lookup` 은 표준 mDNS/DNS-SD 를 쓴다. **두 형식은 서로 호환되지 않는다.** 같은 로컬 네트워크(Wi-Fi · 유선 · 핫스팟)에 있어야 하고 브라우저에서는 안 된다. 같은 네트워크의 상대에게 로컬 IP 가 드러난다. — [local address lookup](https://docs.iroh.computer/connecting/local-address-lookup), [iroh-mdns-address-lookup docs.rs](https://docs.rs/iroh-mdns-address-lookup)
- 옛 정보: `discovery-local-network` feature · `.discovery_local_network()` · `LocalSwarmDiscovery` 는 0.2x~0.3x 시절 API 다. — [local discovery (0.32)](https://docs.iroh.computer/connecting/local-discovery), [iroh-net 0.28 discovery](https://docs.rs/iroh-net/0.28.2/src/iroh_net/discovery.rs.html)
- 1.0 공지: local-first 설정이면 인터넷 없이도 로컬 기기를 찾아 연결할 수 있다. BLE · WiFi Aware · Tor 같은 custom transport(LoRa 는 개발 중)와 자체 QUIC multipath 를 넣었다. — [iroh blog v1](https://iroh.computer/blog/v1)
- Hole punching: 「roughly 9 out of 10 network configurations allow a direct connection」. 일부 회사 방화벽 · 이동통신망 · 「특히 엄격한 설정」에서 실패한다. 실패하면 자동으로 릴레이 경유로 넘어간다. 릴레이는 암호화된 패킷만 넘기고 내용을 읽지 못한다. 한 번 성공한 직접 경로는 네트워크 설정이 그대로인 동안 유지된다. — [holepunching](https://docs.iroh.computer/concepts/holepunching)
- 독립 측정(iroh 아님): libp2p DCUtR hole punching 대규모 측정에서 성공률 약 70%, 성공한 것 중 97.6% 가 첫 시도에 붙었다. — [arXiv 2510.27500](https://arxiv.org/html/2510.27500v1). 2022 IPFS 발표는 약 72%. — [probelab talk](https://probelab.io/talks/libp2p-nat-hole-punching-success-rate/)
- 2차 출처: 블로그 Pinggy 는 「production 에서 약 90%」 「데이터의 약 95% 가 직접」이라고 쓰지만 근거가 n0 주장의 재인용으로 보인다. — [Pinggy](https://pinggy.io/blog/iroh_1_0_dial_keys_not_ips/)
- 사용자 보고(일화): 한 사용자 환경에서는 UPnP 나 공인 IPv6 가 없으면 hole punching 이 실패했다. — [iroh issue #2317](https://github.com/n0-computer/iroh/issues/2317)

### Inferences
- 서버를 못 두는 사용자라면 현실적인 구성은 이렇다. (a) 같은 사무실이면 mDNS lookup 으로 완전 무서버. (b) 그 밖에는 n0 공개 릴레이 + n0 DNS(pkarr). 이미 `portmapper` feature 를 켜 두었으니 UPnP/NAT-PMP 로 직접 연결률을 조금 더 올릴 수 있다(#2317 의 관찰과 맞는다).
- 디스커버리를 완전히 없애려면 상대의 주소(direct addr)를 앱 밖에서 미리 받아야 한다. 티켓에 주소를 담아 메신저로 주고받는 식이다. 하지만 가정 · 사무실 IP 는 바뀌므로 원격 협업에서는 오래 버티지 못한다.
- 10~30% 의 연결은 릴레이로만 흐른다고 보고, 그 경로에서도 덱 동기화가 끝나도록 증분 전송(git fetch 의 have/want 협상)을 쓰는 것이 중요하다.
- 로컬 lookup 두 crate 는 호환되지 않으므로 앱 안에서 하나로 정해야 한다(나중에 바꾸면 옛 판과 서로 못 찾는다).

### Gaps
- iroh 1.x 기준 hole punching 성공률을 독립적으로 잰 공개 측정은 찾지 못했다.
- 릴레이 하드웨어 요구 · QUIC address discovery 포트(예전 문서의 3478/7842 등)의 현재 값은 공개 문서에서 확인하지 못했다(소스 확인 필요).

## 3. 복제용 iroh crate: iroh-gossip · iroh-blobs · iroh-docs 의 성숙도와 git 대체 가능성

### Takeaway
세 crate 모두 0.28(2024)에 iroh 본체에서 떨어져 나가 따로 0.10x 판으로 나온다. 1.0 수준의 안정 약속은 없다. iroh-gossip 은 iroh ^1.4 를 따라가며 활발히 나온다. iroh-docs 는 0.101.0(2026-06-15, iroh 1.0 과 같은 날)이 마지막으로 보인다. 「deprecated」라는 공식 표기는 찾지 못했지만 1.0 대상이 아니라고 이미 밝혔다. git 을 대체하기보다는 gossip 을 「누가 온라인인지 · 새 커밋이 생겼는지」 알림용으로 곁들이는 쪽이 맞다.

### Cited Findings
- 로드맵: v0.27 에서 iroh-blobs · iroh-docs · iroh-gossip 을 별도 저장소로 옮기기로 했고, v0.28.1 에서 「blobs, docs, and gossip are removed from iroh」. v0.35 항목에 「iroh-blobs 1.0 candidate API」, v0.94 항목에 「iroh-blobs compiles to WASM」. deprecation · 유지보수 중단 표기는 없다. — [iroh roadmap](https://www.iroh.computer/roadmap)
- v0.35 블로그(옛 정보, 1.0 이전): 「iroh-docs is not yet ready for a 1.0, so we'll continue releasing minor and patch updates as needed」. iroh-gossip 은 버그 수정 말고는 거의 바뀌지 않을 것이라고 했다. — [iroh v0.35 - Prepping for 1.0](https://iroh.computer/blog/iroh-0-35-prepping-for-1-0)
- iroh-docs 최신 0.101.0, 2026-06-15. 의존: `iroh ^1`, `iroh-blobs ^0.103`, `iroh-gossip ^0.101.0`. — [docs.rs iroh-docs](https://docs.rs/crate/iroh-docs/latest)
- iroh-docs 데이터 모델: replica 가 entry 를 무제한으로 가진다. entry 는 (key, author, namespace) 로 식별하고, 값은 내용의 BLAKE3 해시 · 크기 · 타임스탬프다. **내용 자체는 replica 로 오가지 않고 blobs 로 따로 받는다.** Namespace key 서명이 쓰기 권한의 증명, Author key 서명이 작성자 증명이다. 동기화는 range-based set reconciliation(집합을 재귀로 나눠 fingerprint 를 비교)이다(Aljoscha Meyer 논문). README 에는 유지보수 상태 · 판 언급이 없다. — [n0-computer/iroh-docs](https://github.com/n0-computer/iroh-docs)
- Willow 계열 후속(iroh-willow)은 「not released yet」. — [docs.rs iroh-willow](https://docs.rs/iroh-willow/)
- iroh-gossip 0.103.0: `iroh ^1.4` 에 의존. 32바이트 `TopicId` 로 swarm 을 만들고 `gossip.subscribe(topic_id, bootstrap_peers)` 로 들어간다. 「you need some bootstrap peers to join the swarm」. `receiver.joined()` 는 최소 한 피어와 붙을 때까지 기다린다. HyParView + PlumTree 기반. `Builder::max_message_size` 로 메시지 크기 상한을 정한다. — [docs.rs iroh-gossip](https://docs.rs/iroh-gossip/latest/iroh_gossip/)
- iroh-blobs: BLAKE3 기반 content-addressed blob 전송. 0.103 계열(iroh-docs 가 `^0.103` 을 요구). — [docs.rs iroh](https://docs.rs/crate/iroh/latest), [docs.rs iroh-docs](https://docs.rs/crate/iroh-docs/latest)

### Inferences
- iroh-docs 는 「여러 사람이 쓰는 키-값」이라 겉보기에 맞아 보인다. 하지만 같은 key 를 여러 사람이 쓰면 last-writer-wins(타임스탬프)이고, 3-way merge · 이력 · 되돌리기 같은 git 의 장점이 없다. 게다가 앱은 이미 git 판 관리에 기대고 있다. 갈아타면 득보다 실이 크고, 1.0 밖 crate 라 와이어 호환 약속도 없다.
- iroh-blobs 로 git packfile 이나 bundle 을 BLAKE3 해시로 옮기는 방법은 가능하다(이어받기 · 검증 덕분). 다만 git 의 have/want 협상이 이미 증분을 해결하므로 덱 크기에서는 복잡도만 는다.
- iroh-gossip 은 「덱 ID 에서 만든 TopicId」로 같은 덱의 온라인 피어끼리 「refs 가 바뀌었다(브랜치 → 커밋 해시)」를 알리는 데 알맞다. 다만 bootstrap 피어가 적어도 하나 필요하므로 디스커버리 문제를 대신 풀어 주지는 않는다(4절).
- gossip 도 0.x crate 이므로 판을 고정하고, 덱 동기화의 「정본 경로」는 git fetch 가 맡게 한다. gossip 이 깨져도 다음 연결 때 fetch 로 따라잡는 구조가 안전하다.

### Gaps
- iroh-docs 가 공식적으로 maintenance-only 인지, iroh 1.4/1.5 에 맞춘 새 판이 나올지는 공식 출처에서 확인하지 못했다(0.101.0 이 2026-06-15 이후 마지막으로 보이는 것은 docs.rs 기준 관찰이다).
- iroh-blobs 의 정확한 최신 판과 1.0 안정화 여부는 직접 확인하지 못했다.
- gossip 의 전달 보장(best-effort 여부)과 기본 메시지 크기 값은 docs.rs 첫 페이지에 적혀 있지 않았다.

## 4. git 을 P2P 로 옮기는 방법: bundle · remote helper · upload-pack/receive-pack · gix · 기존 프로젝트

### Takeaway
가장 검증된 길은 이것이다. iroh bi-stream 하나를 열고, 받는 쪽은 `git upload-pack <repo>` 의 stdin/stdout 을 그 stream 에 잇는다. 가져오는 쪽은 `git-remote-<scheme>` helper 의 `connect` capability 로 git 의 native pack 협상을 그대로 실어 나른다. Radicle 이 같은 구조(stream 위 upload-pack, fetch 쪽은 gix-protocol)다. iroh 위 git 은 git-remote-iroh 두 구현이 실험 단계로 있다. 앱이 이미 git CLI 를 부르므로 CLI 방식이 가장 싸고 확실하다. gix 는 fetch 클라이언트는 쓸 만하지만 서버 쪽(upload-pack) · push 는 아직 덜 갖춰져 있다.

### Cited Findings
- gitremote-helpers `connect`: helper 가 원격의 `git upload-pack`(fetch) · `git receive-pack`(push)에 붙어 「git's native packfile protocol」을 쓴다. 「This requires a bidirectional, full-duplex connection」. 응답은 빈 줄(연결됨), `fallback`(dumb 로 내려감), 오류 출력 후 종료 셋 중 하나다. 빈 줄 뒤로는 서비스 출력이 그대로 흐른다. `stateless-connect` 는 protocol v2 용이고 「Experimental; for internal use only」. — [git-scm gitremote-helpers](https://git-scm.com/docs/gitremote-helpers)
- protocol v2: `ls-refs` · `fetch` 명령 단위 요청/응답이다. ref 광고를 필요한 만큼만 받는다. — [gitprotocol-v2](https://web.mit.edu/git/www/gitprotocol-v2.html)
- git bundle: `git bundle create <file> <rev-list-args>` 로 pack + ref 를 파일 하나에 담는다. 받는 쪽이 이미 가진 커밋을 basis 로 주면 증분 bundle 이 되고, `git bundle verify` 로 선행 커밋을 확인하며, bundle 파일을 remote 처럼 `git fetch` 할 수 있다. — [git-scm git-bundle](https://git-scm.com/docs/git-bundle)
- cmars/git-remote-iroh(Codeberg): 「Git protocol helper that connects repositories over iroh p2p network endpoints」. `iroh://` URL 을 git 이 자동으로 이 helper 에 넘긴다. server 모드는 `GIT_DIR` 의 저장소를 서비스한다. 권한은 `peer add <name> <key>` 로 키를 `default` ring 에 넣어 `push:<repo>` 쓰기 · `fetch:<repo>` 읽기를 주는 방식(iroh-rings)이다. 판 0.2.1, 「protocol is unstable」, 0.x 끼리 호환 보장 없음. 비밀키는 저장 시 암호화하지 않고, 브랜치 보호가 없다. 마지막 커밋 2026-09-12. — [codeberg cmars/git-remote-iroh](https://codeberg.org/cmars/git-remote-iroh)
- wronex/iroh-git(GitHub, MIT): `iroh-git-daemon`(Windows 는 `iroh-git-tray`) · `git-iroh` · `git-remote-iroh` · `git-lfs-iroh` 구성이다. URL 은 `iroh://<ticket>/<repo>.git` 이고 티켓에 NODE_ID 와 relay URL 이 들어 있다. n0 기본 릴레이와 n0 DNS(`iroh.link`)를 쓴다. 데몬은 「only accepts connections from a list of known and allowed NODE_IDs」이고, `git iroh grant --write/--lfs`, `revoke` 로 관리한다. 저장소 단위 권한이라 모든 멤버가 모든 ref 를 본다. 크기 제한 · 브랜치별 권한은 없다. 커밋 7개 · 별 9개의 작은 프로젝트다. — [wronex/iroh-git](https://github.com/wronex/iroh-git)
- git-annex 는 iroh 를 P2P 망으로 쓰는 방법을 안내한다(git-annex 자체 P2P 프로토콜). — [git-annex tips: p2p with iroh](https://git-annex.branchable.com/tips/peer_to_peer_network_with_iroh)
- Radicle(Heartwood): `radicle-fetch` 의 `Transport` 가 stream 과 git dir 를 감싸고, handshake 와 fetch 를 stream 의 read/write 반쪽 위에서 돌린다. fetch 경로는 `gix_protocol` 기반이고 Protocol V2 로 `Connection` 을 만든다. 응답 쪽 `radicle-node` 는 stream 에서 git 요청 헤더를 읽고 그 저장소에 대해 upload-pack 을 돌린다. — [radicle-fetch transport.rs 0.18](https://docs.rs/crate/radicle-fetch/0.18.0/source/src/transport.rs), [radicle-node worker.rs](https://docs.rs/radicle-node/0.11.0/src/radicle_node/worker.rs.html)
- Radicle 피어 연결은 Noise XK handshake, Node ID 가 static key 다. — [Radicle Protocol Guide](https://radicle.xyz/guides/protocol)
- (확인 안 된 2차 보도) 2026-09 InfoQ 는 Heartwood 데몬이 handshake 뒤 Noise cipher state 를 버려 framing 쓰기가 암호화를 건너뛴다는 결함 주장을 전했다. Radicle 공식 권고로는 확인하지 못했다. — [InfoQ](https://www.infoq.com/news/2026/09/radicle-network-vulnerabilities/)
- gitoxide: `gix-transport` 에 「implementing your own transports while using git's way of communication」용 feature 가 있다. 진입점은 `client::blocking_io::connect()` · `client::async_io::connect()`. `gix-protocol` 의 fetch 는 넘겨받은 아무 transport 위에서 돌고 V2 에서는 `ls-refs` 로 ref 를 받는다. — [gix-transport docs.rs](https://docs.rs/gix-transport/0.57.0/src/gix_transport/lib.rs.html), [gix-protocol](https://docs.rs/gix-protocol/^0.40.0)
- gitoxide crate-status: push 와 `file://` · `ssh://` 위 self-contained clone/fetch 는 「common workflows that still need plumbing」에 들어 있다. 「upload-pack / receive-pack server plumbing for in-process transports」, 「send-pack / receive-pack client plumbing」은 목록에 있으나 완료 여부를 확인하지 못했다. bundle 은 일부 항목만 있다. — [gitoxide crate-status.md](https://github.com/GitoxideLabs/gitoxide/blob/main/crate-status.md)

### Inferences
- **추천 설계(CLI 방식).** 앱 안에 전용 ALPN(예: `claudeppt/git/1`)을 둔다.
  - 받는 쪽: 연결을 받고 상대 키가 그 덱의 허용 목록에 있는지 본다. 첫 줄로 「덱 ID + 서비스(upload-pack)」를 읽은 뒤 `git upload-pack --stateless-rpc` 가 아닌 일반 `git upload-pack <repo>` 를 띄워 stdin/stdout ↔ iroh SendStream/RecvStream 을 잇는다.
  - 가져오는 쪽: 별도 helper 바이너리 없이 앱이 직접 `git fetch-pack` 을 같은 방식으로 이을 수 있다. 또는 앱 실행 파일을 `git-remote-claudeppt` 로도 부를 수 있게 해 `connect` capability 를 구현하면, 평소의 `git fetch peer-<key>` 가 그대로 된다.
  - 버전 협상 · have/want · 증분 · thin pack 은 git 이 다 해 준다. 이것이 Radicle 이 이미 검증한 모양이다.
- **push 는 쓰지 않는 것을 권한다.** 모든 피어가 완전 사본을 가지므로 「각자 상대에게서 fetch 만」 하면 receive-pack 의 쓰기 권한 문제(남의 ref 를 덮어쓰기)를 통째로 피한다. 상대의 ref 는 `refs/remotes/<peer-key>/*` 같은 이름 공간에 받아 두고, 합치기는 로컬에서 한다.
- **bundle 은 보조 수단이다.** 협상 없는 일방 전송(첫 복제 · 오프라인 파일 전달 · gossip/blobs 로 뿌리기)에 쓴다. 증분 bundle 은 보내는 쪽이 상대가 가진 커밋을 알아야 하므로, 온라인 피어끼리는 upload-pack 협상이 더 정확하다.
- **CLI 대 gix.**
  - CLI: 앱이 이미 git 을 부른다. upload-pack 서버와 fetch 클라이언트가 둘 다 완성품이고 protocol v2 와 호환이 확실하다. 대신 사용자 PC 에 git 이 있어야 하고(번들 배포 가능), Windows 에서 프로세스 생성 비용과 stdio 파이프 처리(바이너리 모드 · 버퍼링)에 신경 써야 한다.
  - gix: 프로세스가 없고 Rust 안에서 끝나며 async 와 잘 맞는다. 하지만 서버 쪽 upload-pack 이 완성되었는지 확인되지 않았고, push 도 「still need plumbing」이다. 지금은 「fetch 쪽만 gix(Radicle 방식) + 응답 쪽은 git upload-pack」의 혼합이 gix 를 쓰는 현실적 상한이다.
- 기존 git-remote-iroh 두 구현은 실험 단계이고 키 · 권한 모델이 앱과 따로 놀므로, 의존성으로 쓰기보다 구조 참고용으로 보는 것이 맞다(특히 cmars 판은 비밀키를 암호화하지 않고 저장한다).

### Gaps
- 두 git-remote-iroh 구현이 upload-pack 을 stream 에 잇는지 bundle 을 쓰는지는 README 만으로 확인하지 못했다(소스 확인 필요). 둘 다 iroh 판 · ALPN 문자열을 README 에 적지 않았다.
- gitoxide 의 upload-pack 서버 구현이 지금 쓸 수 있는 수준인지는 crate-status 에서 체크 상태를 읽지 못해 확인하지 못했다.
- Windows 에서 `git upload-pack` stdio 를 tokio 로 이을 때의 구체적 함정에 대한 공개 사례는 찾지 못했다.

## 5. 「호스트」 없이 같은 덱을 가진 피어 찾기: gossip topic · pkarr/DNS · 키 교환

### Takeaway
iroh 의 디스커버리는 「키를 이미 알 때 주소를 찾아 주는 것」(pkarr/DNS, mDNS)이지, 「이 덱을 가진 사람이 누구인지」를 찾아 주지는 않는다. 덱 멤버의 키 목록은 덱 저장소 안(git 에 담긴 멤버 파일)에 두고, 처음 한 번만 초대 티켓으로 키를 건넨다. 그다음부터는 멤버 키마다 pkarr 로 주소를 찾아 아무나 온라인인 사람에게 붙는 구조가 맞다. gossip topic 은 그 위에서 「바뀜 알림」 통로가 된다.

### Cited Findings
- pkarr/DNS lookup: endpoint 가 서명한 레코드를 Pkarr 서버(기본은 n0 가 운영하는 `iroh-dns-server`)에 올린다. 레코드에는 endpoint ID 와 home relay URL 이 기본이고 직접 주소도 담을 수 있다. TXT 속성은 `relay=<url>`, `addr=<addr> ...`. 조회 이름은 `_iroh.<z32-endpoint-id>.dns.iroh.link`(TXT)이고, 시스템 DNS resolver 를 쓴다. 서명이 있어 그 ID 의 주인이 올린 것인지 검증된다. 「others must already know your endpoint ID」. — [discovery concepts](https://docs.iroh.computer/concepts/discovery)
- gossip 은 32바이트 TopicId 와 bootstrap 피어가 있어야 swarm 에 들어간다. — [docs.rs iroh-gossip](https://docs.rs/iroh-gossip/latest/iroh_gossip/)
- iroh-git(wronex)는 티켓(NODE_ID + relay URL)을 URL 에 넣어 건네고, 티켓에 relay 힌트가 없으면 DNS lookup 으로 넘어간다. — [wronex/iroh-git](https://github.com/wronex/iroh-git)
- iroh-docs 는 namespace 공개키(NamespaceId)가 replica 를 가리키고, 쓰기 권한은 namespace 비밀키로 증명한다. 「덱 = namespace」 식의 초대 모델 참고가 된다. — [n0-computer/iroh-docs](https://github.com/n0-computer/iroh-docs)

### Inferences
- 제안 흐름:
  1. 덱을 만들 때 덱 ID(무작위 32바이트 또는 첫 커밋 해시)를 정한다.
  2. 초대할 때 「덱 ID + 초대한 사람의 EndpointAddr(키 + relay + 주소)」를 티켓으로 건넨다.
  3. 받은 사람이 처음 fetch 하면 덱 저장소 안의 `members` 파일(키 · 이름 · 권한)이 함께 온다.
  4. 그 뒤로는 members 의 키마다 pkarr/mDNS 로 주소를 찾아 온라인인 누구에게서든 fetch 한다.
  5. `TopicId = hash("claudeppt-deck" ‖ 덱 ID)` 인 gossip 에 members 를 bootstrap 으로 넣어 들어가고, 「내 refs 가 X 로 바뀌었다」를 알린다.
- 덱 ID 에서 만든 TopicId 는 짐작할 수 있다. 그래도 gossip 에 들어오는 연결도 키 허용 목록으로 거르면 남이 끼어들 수 없다. gossip 메시지는 「알림」일 뿐이고 실제 데이터는 인증된 fetch 로만 받으므로, 알림이 위조돼도 피해는 헛 fetch 한 번이다.
- 멤버 전원이 오프라인이면 동기화는 멈춘다. 무서버 설계의 본질적 한계로, 「마지막으로 본 시각」을 화면에 보여 주는 정도로 다룬다. 저장 · 중계만 하는 「상시 피어」는 사용자가 원할 때만 더하는 선택지로 둔다.
- pkarr 레코드는 n0 DNS 서버에 기대므로 그 서버가 죽으면 원격 피어를 못 찾는다. 마지막으로 성공한 상대 주소를 로컬에 캐시해 두고 먼저 시도하면 그 의존을 줄일 수 있다.

### Gaps
- pkarr 레코드 TTL · 재게시 주기, n0 DNS 서버의 운영 약속(SLA)은 문서에서 찾지 못했다.
- 공개 「DHT 로 덱 ID → 피어」를 찾는 iroh 1.x 공식 기능(예전 pkarr mainline DHT 옵션)이 지금도 있는지 확인하지 못했다.

## 6. 보안: ALPN · 키로 피어 인증 · fetch 할 수 있는 피어 제한

### Takeaway
iroh 연결은 TLS 1.3 위 QUIC 이고 상대 EndpointId(ed25519 공개키)가 handshake 에서 검증된다. 그래서 「키 = 신원」이 공짜로 따라온다. 앱이 할 일은 받을 ALPN 을 정하고, 받은 연결의 원격 ID 를 덱별 허용 목록과 비교해 거절하는 것이다. 1.x 의 `EndpointHooks` 로 연결 설정 단계에서 거절할 수 있다.

### Cited Findings
- `Builder::alpns(Vec<Vec<u8>>)`: 들어오는 연결에서 받을 ALPN 을 정한다. 받으려면 ALPN 이 적어도 하나 있어야 하고, 상대가 여럿을 내면 내 목록의 첫 일치가 고른다. — [docs.rs iroh endpoint Builder](https://docs.rs/iroh/latest/iroh/endpoint/struct.Builder.html)
- `Builder::hooks`: 「Endpoint hooks intercept the connection establishment process of an Endpoint」. 설치 순서대로 돌고 하나가 reject 하면 처리를 멈춘다. 별도 accept filter 는 없고, `addr_filter` 는 게시할 주소를 거르는 기능이다. — [docs.rs iroh endpoint Builder](https://docs.rs/iroh/latest/iroh/endpoint/struct.Builder.html)
- 릴레이는 암호화된 패킷만 넘기고 앱 데이터를 읽지 못한다. — [holepunching](https://docs.iroh.computer/concepts/holepunching)
- 공개 릴레이 트래픽은 종단간 암호화되지만, n0 는 민감 · 기밀 데이터에 공개 릴레이를 권하지 않는다. — [public relays](https://docs.iroh.computer/iroh-services/relays/public)
- 로컬 lookup 은 같은 네트워크에 로컬 IP 를 알린다. 「A connected peer may learn your IP addresses; take this into account if your application authenticates peers after accepting connections」. — [local address lookup](https://docs.iroh.computer/connecting/local-address-lookup)
- 선례: wronex/iroh-git 는 허용 NODE_ID 목록으로만 받고, cmars/git-remote-iroh 는 iroh-rings 로 `fetch:<repo>` · `push:<repo>` 권한을 키마다 준다(비밀키 평문 저장 · 브랜치 보호 없음). — [wronex/iroh-git](https://github.com/wronex/iroh-git), [cmars/git-remote-iroh](https://codeberg.org/cmars/git-remote-iroh)

### Inferences
- 점검 목록:
  1. 기능마다 ALPN 을 나눈다(`.../git/1`, `.../gossip`, 옛 HTTP/WS 용). 와이어를 바꾸면 ALPN 숫자를 올려 옛 판과 섞이지 않게 한다.
  2. 연결을 받으면 `remote_id` 를 덱 members 와 비교한다. 서비스 요청 첫 줄의 덱 ID 가 그 키에 허용된 덱인지 한 번 더 본다. 키가 여러 덱에 걸쳐 있어도 남의 덱을 받아 가지 못하게 하기 위해서다.
  3. upload-pack 에 넘기는 저장소 경로는 덱 ID 로 앱이 정한다. 상대가 준 경로 문자열을 그대로 쓰지 않는다(경로 탈출 방지).
  4. upload-pack 만 열고 receive-pack 은 열지 않는다(남이 내 ref 를 쓰지 못하게).
  5. git 쪽 설정은 `uploadpack.allowAnySHA1InWant` 등을 끈 기본값으로 둔다. 숨길 ref(개인 작업 ref)가 있으면 `uploadpack.hideRefs` 를 쓴다.
  6. 비밀키는 OS 키 저장소(Windows DPAPI/Credential Manager)에 둔다. cmars 판의 평문 저장을 되풀이하지 않는다.
  7. members 파일 자체는 git 이력에 남으므로, 「누가 누구를 넣었는지」는 커밋 서명 또는 멤버 변경 승인 규칙으로 묶어야 한다. 그러지 않으면 멤버 하나가 members 를 고쳐 남을 끼워 넣을 수 있다.
- 받는 연결 수 · 동시 upload-pack 수 · 응답 크기에 상한을 둔다. 허용된 피어가 실수나 악의로 과도한 요청을 보내는 것을 막기 위해서다. 두 git-remote-iroh 구현 모두 「크기 제한 없음」을 한계로 적고 있다.

### Gaps
- `EndpointHooks` 가 handshake 의 어느 단계(원격 ID 를 안 뒤 · ALPN 을 고르기 전)에서 도는지는 trait 문서를 따로 확인하지 못했다.
- iroh 1.x 의 TLS 인증 방식(raw public key 등)의 세부와 0-RTT 재전송 위험에 대한 공식 설명은 이번 조사에서 확인하지 못했다.
