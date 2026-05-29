# frozen_string_literal: true

class HomeFeed < Feed
  # =====================================================================
  #  Twitter X 식 chain compress — root + newest leaf 만 표시
  #
  #  정책 (트위터 X 최신 동작 정합):
  #   • 같은 chain root 의 모든 답글 중 newest leaf 하나만 timeline 표시
  #     - A → B1 → B2 → ... → B100 → timeline 에 [A, B100] 만
  #     - A → C (newer 평행 답글) → timeline 에 [A, C] 만 (B chain 모두 제거)
  #     - chain 의 중간 답글 (B1 ~ B99) 모두 생략
  #   • Root (A) 와 leaf (B100) 사이는 ChainCollapseIndicator ("더 많은 답글 보기")
  #     로 시각적으로 묶임. 클릭 시 root 상세 페이지로 이동.
  #   • Self-thread / 다른 사용자 mixed chain 무관 — 동일 정책 적용.
  #
  #  알고리즘 (3 단계):
  #   1. fetch_self_thread_ancestors — BFS 로 ancestor 전체 fetch
  #   2. seen_per_root — 같은 chain root 의 답글 중 newest 만 유지, 나머지 + 자손 제거
  #   3. chain compress — 각 답글의 chain root 만 inject (중간 ancestor 모두 생략)
  #
  #  DM 격리 정책 유지:
  #   (a) 답글이 DM 인 경우 home 노출 X (read-time 필터)
  #   (b) DM 의 답글 (부모가 direct) 도 home 노출 X
  #   (c) ancestor 가 DM 이면 inject 안 함 (visible_ancestor? 에서 차단)
  # =====================================================================

  # Self-thread BFS 최대 깊이 — 100+ 단계 chain 도 root 까지 fetch 가능.
  # 200 단계 이상은 corrupted data / 순환참조 방어용 상한 (실무에서 chain 평균 1-5단계).
  MAX_SELF_THREAD_DEPTH = 200

  def initialize(account)
    @account = account
    super(:home, account.id)
  end

  def get(limit, max_id = nil, since_id = nil, min_id = nil)
    statuses = super.where.not(visibility: :direct).to_a

    # (b) DM 의 답글 제거 — 답글의 in_reply_to_id 가 direct status 면 제거
    reply_ids = statuses.filter_map(&:in_reply_to_id).uniq
    if reply_ids.any?
      direct_parent_ids = Status.where(id: reply_ids, visibility: :direct).pluck(:id).to_set
      statuses = statuses.reject { |s| s.in_reply_to_id && direct_parent_ids.include?(s.in_reply_to_id) } unless direct_parent_ids.empty?
    end

    # Pagination cursor — redis-originated statuses 의 oldest/newest ID
    unless statuses.empty?
      @pagination_max_id = statuses.last.id   # default_scope 'recent' (id desc) → last = oldest
      @pagination_since_id = statuses.first.id # first = newest
    end

    inject_ancestors(statuses)
  end

  def async_refresh
    @async_refresh ||= AsyncRefresh.new(redis_regeneration_key)
  end

  def regenerating?
    async_refresh.running?
  rescue Redis::CommandError
    retry if upgrade_redis_key!
  end

  def regeneration_in_progress!
    @async_refresh = AsyncRefresh.create(redis_regeneration_key)
  rescue Redis::CommandError
    upgrade_redis_key!
  end

  def regeneration_finished!
    async_refresh.finish!
  rescue Redis::CommandError
    retry if upgrade_redis_key!
  end

  # 컨트롤러가 pagination header 생성 시 사용 — raw statuses 기준 cursor.
  attr_reader :pagination_max_id, :pagination_since_id

  private

  # Twitter X 식 chain compress + 평행 답글 정리
  #
  # 알고리즘:
  #   1. BFS — 각 답글의 직속 부모 fetch, 부모의 author 가 자식의 author 와 같으면
  #      (self-thread) 그 부모의 부모도 fetch. 다른 author 면 fetch 끝.
  #   2. **평행 답글 정리 (chain root 단위)** — 같은 chain root 의 답글 중 newest leaf
  #      하나만 유지, 나머지 + chain 자손 모두 제거.
  #   3. **chain compress** — 각 답글의 chain root 만 timeline 에 insert
  #      (중간 ancestor 모두 생략 → 클라이언트가 ChainCollapseIndicator 로 시각화)
  def inject_ancestors(statuses)
    return statuses if statuses.empty?

    visible_ancestors = fetch_self_thread_ancestors(statuses)

    # (2) 평행 답글 정리 — 같은 chain root 의 답글 중 newest leaf 만 유지 +
    #     제거된 답글의 chain 자손 재귀 제거 (chain 일관성)
    #
    # 트위터 X 식 정확한 정합:
    #   • A → B1 → B2 → ... → B100 chain 에서 newest leaf (B100) 만 timeline 표시
    #   • A → C (newer 평행 답글) 가 있으면 C 만 표시, B chain 모두 제거
    #   • 같은 chain root 의 모든 답글 (self-thread 의 중간 답글 포함) 중 newest 하나만
    #
    # 이전 algorithm (direct parent 비교) 의 한계:
    #   • Chain 의 각 level 에서만 비교 → 다른 level 의 평행 답글 정리 X
    #   • 예: A → B → B1, A → C → C1 둘 다 유지 (B, C 가 다른 parent A 의 평행이라
    #     newest 만 유지하지만 B1/C1 chain 자손은 별도 처리)
    #
    # 새 algorithm (chain root 비교):
    #   • 각 답글의 chain root 찾음 (find_chain_root walk up)
    #   • 같은 root 의 모든 답글 중 newest 만 유지
    #   • 제거된 답글의 chain 자손 재귀 제거 (preserved_ids 인 newest 는 보호)

    # 1차 — chain root 단위 평행 답글 정리
    seen_per_root = {}
    removed_ids = Set.new

    statuses.each do |status|
      next if status.in_reply_to_id.nil? # root status — 정리 대상 X

      root = find_chain_root(status, visible_ancestors)
      next if root.nil? || root.id == status.id # 자기가 root 면 정리 대상 X

      if seen_per_root.key?(root.id)
        removed_ids.add(status.id) if seen_per_root[root.id] != status.id
      else
        seen_per_root[root.id] = status.id
      end
    end

    preserved_ids = seen_per_root.values.to_set

    # 2차 — 자손 재귀 제거 (preserved_ids 의 newest leaf 는 보호)
    loop do
      newly_removed = statuses.select do |s|
        !removed_ids.include?(s.id) &&
          !preserved_ids.include?(s.id) &&
          s.in_reply_to_id &&
          removed_ids.include?(s.in_reply_to_id)
      end
      break if newly_removed.empty?

      newly_removed.each { |s| removed_ids.add(s.id) }
    end

    filtered = statuses.reject { |s| removed_ids.include?(s.id) }

    return filtered if visible_ancestors.empty?

    # (3) chain compress — 각 답글의 chain root 만 inject (중간 ancestor 모두 생략)
    #
    # 시나리오:
    #   • A → B100 (raw 답글) → result = [A, B100]
    #     B100 의 chain root = A. A 가 timeline 의 B100 직전에 inject.
    #     B1 ~ B99 (중간) 모두 생략.
    #   • A → C (직속 답글, root 의 immediate-child) → result = [A, C]
    #     C 의 chain root = A. A 가 timeline 의 C 직전에 inject.
    #     중간 ancestor 없음 (depth 1 chain).
    #
    # 클라이언트 시각:
    #   • [A, leaf] 사이 거리 (A 가 leaf 의 직속 부모 아님) → ChainCollapseIndicator 표시
    #   • [A, immediate-child] 인접 → 단순 thread line 만 (indicator 안 보임)
    result = []
    result_ids = Set.new

    filtered.each do |status|
      if status.in_reply_to_id.nil?
        # Root status — 그대로 추가
        next if result_ids.include?(status.id)

        result << status
        result_ids.add(status.id)
      else
        root = find_chain_root(status, visible_ancestors)

        # Chain root 가 있고 아직 result 에 없으면 status 직전에 insert
        if root && !result_ids.include?(root.id)
          result << root
          result_ids.add(root.id)
        end

        unless result_ids.include?(status.id)
          result << status
          result_ids.add(status.id)
        end
      end
    end

    result
  end

  # BFS 로 self-thread chain 의 모든 ancestor fetch.
  # 다른 사람의 답글 (non-self-thread) 인 경우 직속 부모만 fetch 하고 stop.
  def fetch_self_thread_ancestors(statuses)
    visible_ancestors = {}
    to_fetch = statuses.filter_map(&:in_reply_to_id).uniq
    depth = 0

    while !to_fetch.empty? && depth < MAX_SELF_THREAD_DEPTH
      fetched = Status.where(id: to_fetch).where.not(visibility: :direct).includes(:account).to_a
      next_to_fetch = []

      fetched.each do |parent|
        next if visible_ancestors.key?(parent.id)
        next unless visible_ancestor?(parent)

        visible_ancestors[parent.id] = parent

        # Self-thread 검사 — parent 의 author 가 자기 자식의 author 와 같은지.
        # 자식 = raw statuses 또는 이미 fetched 된 ancestors 중 in_reply_to_id == parent.id 인 것.
        direct_children_authors = []
        statuses.each { |s| direct_children_authors << s.account_id if s.in_reply_to_id == parent.id }
        visible_ancestors.each_value { |a| direct_children_authors << a.account_id if a.in_reply_to_id == parent.id }

        # parent.author 가 어떤 자식의 author 와 같으면 self-thread → grand-parent 도 fetch
        if parent.in_reply_to_id && direct_children_authors.include?(parent.account_id)
          next_to_fetch << parent.in_reply_to_id unless visible_ancestors.key?(parent.in_reply_to_id)
        end
      end

      to_fetch = next_to_fetch.uniq
      depth += 1
    end

    visible_ancestors
  end

  # Status 부터 chain 의 root 까지 walk up. visible_ancestors 에 없는 in_reply_to_id
  # 만나면 거기서 stop (그 직전 status 가 root).
  #
  # 반환: chain root status (= in_reply_to_id 가 null 이거나 visible_ancestors 에 없는 답글).
  # status 자체가 root (in_reply_to_id null) 인 경우 status 그대로 반환.
  #
  # 안전 제한:
  #   • visited set 으로 순환 참조 차단
  #   • MAX_SELF_THREAD_DEPTH 안전 상한
  def find_chain_root(status, visible_ancestors)
    current = status
    visited = Set.new([status.id])
    depth = 0

    while current.in_reply_to_id && (parent = visible_ancestors[current.in_reply_to_id])
      break if visited.include?(parent.id) || depth >= MAX_SELF_THREAD_DEPTH

      visited.add(parent.id)
      current = parent
      depth += 1
    end

    current
  end

  # ancestor 표시 가시성 — 한 군데서 일괄 결정
  #   • 차단/뮤트/도메인차단 한 계정 → X
  #   • suspended / unavailable → X (StatusPolicy 안에서 처리)
  #   • private/limited 인데 팔로우 안 함 → X
  #   • direct(DM) → X (DM 격리 정책)
  def visible_ancestor?(ancestor)
    return false unless ancestor
    return false if ancestor.direct_visibility?

    account = ancestor.account
    return false if @account.blocking?(account)
    return false if @account.muting?(account)
    return false if account.domain.present? && @account.domain_blocking?(account.domain)

    StatusPolicy.new(@account, ancestor).show?
  end

  def redis_regeneration_key
    @redis_regeneration_key = "account:#{@account.id}:regeneration"
  end

  def upgrade_redis_key!
    if redis.type(redis_regeneration_key) == 'string'
      redis.del(redis_regeneration_key)
      regeneration_in_progress!
      true
    end
  end
end
