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

  def initialize(account)
    @account = account
    super(:home, account.id)
  end

  # Override Feed#get — Redis 에서 가져온 statuses 위에 ancestor 인젝션.
  # 반환: Array<Status> (PreloadingConcern 의 preload_collection 이 Array 처리 가능)
  def get(limit, max_id = nil, since_id = nil, min_id = nil)
    inject_ancestors(super)
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

    # 이미 timeline 안에 있는 parent 는 skip (중복 방지)
    timeline_ids = statuses.map(&:id).to_set

    parent_ids = statuses
                 .filter_map(&:in_reply_to_id)
                 .uniq
                 .reject { |id| timeline_ids.include?(id) }

    return statuses if parent_ids.empty?

    # 한 번에 batch fetch (N+1 회피) + 가시성 필터링
    visible_ancestors = Status
                        .where(id: parent_ids)
                        .includes(:account)
                        .index_by(&:id)
                        .select { |_id, ancestor| visible_ancestor?(ancestor) }

    return statuses if visible_ancestors.empty?

    # Sliding-window dedup 으로 parent 1번만 노출
    result = []
    recent_parent_ids = []

    statuses.each do |status|
      parent_id = status.in_reply_to_id

      if parent_id && visible_ancestors[parent_id] && !recent_parent_ids.include?(parent_id)
        result << visible_ancestors[parent_id]
        recent_parent_ids << parent_id
        recent_parent_ids.shift if recent_parent_ids.size > ANCESTOR_DEDUP_WINDOW
      end

      result << status
    end

    result
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
