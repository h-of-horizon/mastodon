# frozen_string_literal: true

class HomeFeed < Feed
  # =====================================================================
  #  Twitter 식 chain 처리 — self-thread 전체 inject + 다른 사람 chain 은 직속 부모만
  #
  #  정책:
  #   • Self-thread (사용자가 자기 답글로 만든 chain): root 까지 전체 inject.
  #     트위터의 "사용자의 self-thread 는 한 panel" 동작과 일치.
  #   • 다른 사람과의 chain (작성자가 다른 사용자의 글에 답글): 직속 부모만 inject.
  #     그 위 grand-parent 는 추적 X. 답글 카드 아래에 "이어지는 글타래 보기" link
  #     로 사용자가 상세 페이지로 이동 가능 (status_quoted.tsx 의 ShowThreadLink).
  #
  #  BFS 알고리즘 (max_depth 50 안전 제한):
  #   1. raw statuses 의 직속 부모 batch fetch
  #   2. 각 부모가 자기 자식의 author 와 같은 (self-thread) 인 경우만 grand-parent fetch
  #   3. 다른 author 면 chain 끝 — 더 이상 fetch X
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

  # Twitter 식 chain inject — self-thread 는 전체, 다른 사람 chain 은 직속 부모만 +
  # 같은 root 의 평행 답글은 newest 하나만 유지 (트위터의 "원글당 답글 chain 하나" 정책).
  #
  # 알고리즘:
  #   1. BFS — 각 답글의 직속 부모 fetch, 부모의 author 가 자식의 author 와 같으면
  #      (self-thread) 그 부모의 부모도 fetch. 다른 author 면 fetch 끝.
  #   2. **평행 답글 정리** — 같은 chain root 의 직속 답글 (root 의 immediate-child)
  #      이 다른 답글이면 평행 답글 → newest 하나만 유지, 나머지 제거.
  #   3. 각 (filtered) raw status 의 chain build → ancestor 를 status 직전에 insert
  def inject_ancestors(statuses)
    return statuses if statuses.empty?

    visible_ancestors = fetch_self_thread_ancestors(statuses)

    # (2) 평행 답글 정리 — 같은 direct parent (in_reply_to_id) 의 답글 중 newest 만 유지 +
    #     제거된 평행 답글의 chain 자손도 함께 제거 (재귀)
    #
    # 트위터 식 정확한 정합:
    #   • 같은 parent 의 답글 중 newest 만 유지
    #   • 제거된 답글의 chain 자손 (제거된 답글의 답글들) 도 함께 제거 — chain 일관성
    #
    # 예: A → B(notice 본인) → B1, B2 + A → C(world) → C1, C2
    #   1차 정리: B 유지, C 제거 (newest = B 가정)
    #   2차 자손 제거: C 의 자손 C1, C2 도 제거 (C 가 timeline 에 없으니 C1/C2 가 단독 카드
    #                                                되어 시각 불일관)
    #
    # statuses 가 newest-first 정렬 (default_scope 'recent') 이므로 첫 hit = newest.

    # 1차 — 같은 parent 평행 답글 중 newest 만 유지 식별
    seen_per_parent = {}
    removed_ids = Set.new

    statuses.each do |status|
      parent_id = status.in_reply_to_id
      next if parent_id.nil?

      if seen_per_parent.key?(parent_id)
        removed_ids.add(status.id) if seen_per_parent[parent_id] != status.id
      else
        seen_per_parent[parent_id] = status.id
      end
    end

    # 2차 — 제거된 status 의 chain 자손 재귀 제거 (chain 일관성)
    # fixed-point iteration: 더 이상 새로 제거할 자손이 없을 때까지 반복
    loop do
      newly_removed = statuses.select do |s|
        !removed_ids.include?(s.id) && s.in_reply_to_id && removed_ids.include?(s.in_reply_to_id)
      end
      break if newly_removed.empty?

      newly_removed.each { |s| removed_ids.add(s.id) }
    end

    filtered = statuses.reject { |s| removed_ids.include?(s.id) }

    return filtered if visible_ancestors.empty?

    # (3) filtered statuses 의 chain inject
    result = []
    result_ids = Set.new

    filtered.each do |status|
      chain = build_self_thread_chain(status, visible_ancestors)

      chain.each do |ancestor|
        next if result_ids.include?(ancestor.id)

        status_idx = result.index { |s| s.id == status.id }
        if status_idx
          result.insert(status_idx, ancestor)
        else
          result << ancestor
        end
        result_ids.add(ancestor.id)
      end

      unless result_ids.include?(status.id)
        result << status
        result_ids.add(status.id)
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

  # Status 부터 self-thread chain 의 root 까지 (또는 다른 author 만나는 직속 부모까지) 거슬러 올라감.
  # 반환: chronological 순서 [oldest_ancestor, ..., direct_parent] (status 자체는 미포함).
  #
  # 종료 조건:
  #   • 직속 부모가 visible_ancestors 에 없음 → stop
  #   • 직속 부모의 author 가 자식의 author 와 다름 (non-self-thread) → 직속 부모만 chain 에 추가하고 stop
  def build_self_thread_chain(status, visible_ancestors)
    chain = []
    current = status

    while current.in_reply_to_id && (parent = visible_ancestors[current.in_reply_to_id])
      chain.unshift(parent)

      # parent 가 자식과 다른 author 면 chain 의 root (또는 root 보다 위) → stop
      break unless parent.account_id == current.account_id

      current = parent
    end

    chain
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
