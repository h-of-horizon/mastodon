# frozen_string_literal: true

class HomeFeed < Feed
  # =====================================================================
  #  Twitter 스타일 ancestor 인젝션
  #
  #  답글(in_reply_to_id 가 있는 status) 위에 immediate parent status 를
  #  자동으로 끼워 노출해 답글이 문맥 없이 떠 있지 않게 함.
  #
  #  - 직속 parent 1개만 (chain 위로 더 안 올라감)
  #  - sliding-window dedup: 같은 parent 가 직전 N개 안에 등장했으면 재출현 X
  #  - 안 보이는 ancestor (삭제/차단/뮤트/도메인차단/비공개/DM 등)는 skip
  #  - 이미 timeline 안에 parent 가 있으면 중복 X
  # =====================================================================
  ANCESTOR_DEDUP_WINDOW = 5
  # chain walking 최대 깊이 — A→B1→B2→...→Bn 가 무한 chain 인 corrupted 데이터 방어
  MAX_CHAIN_DEPTH = 8

  def initialize(account)
    @account = account
    super(:home, account.id)
  end

  # Override Feed#get — Redis 에서 가져온 statuses 위에 ancestor 인젝션.
  # 반환: Array<Status> (PreloadingConcern 의 preload_collection 이 Array 처리 가능)
  #
  # 정책 (DM 관련 완전 격리):
  #   (a) DM(direct visibility) 자체 제외
  #   (b) DM 에 대한 답글(부모가 direct visibility) 제외
  #       — 답글 본인이 public/unlisted 이어도 DM thread 의 일부면 home 노출 X
  #
  # FeedManager.filter_from_home 가 write-time 에 이미 차단하지만, Redis 에
  # 이전부터 남아 있는 항목까지 즉시 사라지도록 read-time 에서도 한 번 더 필터.
  def get(limit, max_id = nil, since_id = nil, min_id = nil)
    statuses = super.where.not(visibility: :direct).to_a

    # (b) DM 의 답글 제거 — 답글의 in_reply_to_id 가 direct status 면 제거
    reply_ids = statuses.filter_map(&:in_reply_to_id).uniq
    if reply_ids.any?
      direct_parent_ids = Status.where(id: reply_ids, visibility: :direct).pluck(:id).to_set
      statuses = statuses.reject { |s| s.in_reply_to_id && direct_parent_ids.include?(s.in_reply_to_id) } unless direct_parent_ids.empty?
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

  private

  def inject_ancestors(statuses_relation)
    statuses = statuses_relation.to_a
    return statuses if statuses.empty?

    # ── 1단계: BFS 로 chain 전체의 ancestor 들 batch fetch ──
    # A → B1 → B2 → B3 같은 깊은 self-reply chain 에서 root 까지 거슬러 올라감.
    # MAX_CHAIN_DEPTH 로 순환 참조 / 데이터 corruption 방어.
    all_ancestor_ids = Set.new
    to_fetch = statuses.filter_map(&:in_reply_to_id).uniq
    fetched = {}
    depth = 0

    while to_fetch.any? && depth < MAX_CHAIN_DEPTH
      next_to_fetch = []

      # find_each → each — 작은 배치(<100)라 batching 오버헤드 불필요
      Status.where(id: to_fetch).where.not(visibility: :direct).includes(:account).each do |ancestor|
        next if fetched.key?(ancestor.id)

        fetched[ancestor.id] = ancestor
        all_ancestor_ids.add(ancestor.id)

        # 다음 depth: 방금 fetch 한 ancestor 의 parent 중 아직 안 가져온 것
        if ancestor.in_reply_to_id && !all_ancestor_ids.include?(ancestor.in_reply_to_id)
          next_to_fetch << ancestor.in_reply_to_id
        end
      end

      to_fetch = next_to_fetch.uniq
      depth += 1
    end

    # 가시성 필터 — 차단/뮤트/도메인차단/private(팔로우 안 함)/direct 제외
    visible_ancestors = fetched.select { |_id, ancestor| visible_ancestor?(ancestor) }

    # 조기 return: 아무 ancestor 도 가시적이지 않으면 원본 그대로
    return statuses if visible_ancestors.empty? && statuses.none? { |s| s.in_reply_to_id }

    # ── 2단계: 각 status 의 chain 을 chronological 로 빌드 + dedup ──
    # 결과: [root, mid1, ..., parent, reply] 순서로 result 에 추가
    # sliding-window dedup: 같은 root 가 직전 N 개 안에 있으면 ancestors skip (reply 만)
    result = []
    result_ids = Set.new
    recent_root_ids = []

    statuses.each do |status|
      chain = build_chain(status, visible_ancestors)
      root_id = chain.first.id

      if recent_root_ids.include?(root_id)
        # 같은 thread 의 다른 reply 가 이미 chain 째 노출됨 → 이번 reply 만 추가
        append_unique(result, result_ids, status)
      else
        # 신선한 chain → root 부터 chronologically 추가
        chain.each do |s|
          # 이미 result 의 다른 위치에 있으면 제거 후 재배치 (chain 으로 묶이는 게 우선)
          result.delete_if { |x| x.id == s.id } if result_ids.include?(s.id)
          result << s
          result_ids.add(s.id)
        end

        recent_root_ids << root_id
        recent_root_ids.shift if recent_root_ids.size > ANCESTOR_DEDUP_WINDOW
      end
    end

    result
  end

  # status 에서 ancestors 를 거슬러 올라가 chain 을 구성.
  # 반환: [root, ..., parent, status] (chronological)
  # 순환 참조 방어 + MAX_CHAIN_DEPTH 제한
  def build_chain(status, visible_ancestors)
    chain = [status]
    seen_in_chain = Set.new([status.id])
    current = status

    while current.in_reply_to_id &&
          visible_ancestors[current.in_reply_to_id] &&
          !seen_in_chain.include?(current.in_reply_to_id) &&
          chain.size < MAX_CHAIN_DEPTH
      parent = visible_ancestors[current.in_reply_to_id]
      chain.unshift(parent)
      seen_in_chain.add(parent.id)
      current = parent
    end

    chain
  end

  def append_unique(result, result_ids, status)
    return if result_ids.include?(status.id)

    result << status
    result_ids.add(status.id)
  end

  # ancestor 표시 가시성 — 한 군데서 일괄 결정
  #   • 차단/뮤트/도메인차단 한 계정 → X
  #   • suspended / unavailable → X (StatusPolicy 안에서 처리)
  #   • private/limited 인데 팔로우 안 함 → X
  #   • direct(DM) 인데 본인 미언급 → X
  def visible_ancestor?(ancestor)
    return false unless ancestor

    account = ancestor.account
    return false if @account.blocking?(account)
    return false if @account.muting?(account)
    return false if account.domain.present? && @account.domain_blocking?(account.domain)

    # Mastodon 표준 가시성 정책 (suspended / private / direct / 도메인 등 일괄)
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
