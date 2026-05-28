# frozen_string_literal: true

class Api::V1::Timelines::HomeController < Api::V1::Timelines::BaseController
  include AsyncRefreshesConcern

  before_action -> { doorkeeper_authorize! :read, :'read:statuses' }
  before_action :require_user!

  PERMITTED_PARAMS = %i(local limit).freeze

  def show
    with_read_replica do
      @statuses = load_statuses
      @relationships = StatusRelationshipsPresenter.new(@statuses, current_user&.account_id)
    end

    add_async_refresh_header(account_home_feed.async_refresh, retry_seconds: 5)

    render json: @statuses,
           each_serializer: REST::StatusSerializer,
           relationships: @relationships,
           status: account_home_feed.regenerating? ? 206 : 200
  end

  private

  def load_statuses
    preloaded_home_statuses
  end

  def preloaded_home_statuses
    preload_collection home_statuses, Status
  end

  def home_statuses
    account_home_feed.get(
      limit_param(DEFAULT_STATUSES_LIMIT),
      params[:max_id],
      params[:since_id],
      params[:min_id]
    )
  end

  def account_home_feed
    # Memoize 필수 — pagination cursor 가 HomeFeed instance 의 @pagination_max_id
    # 를 사용하므로, show 액션과 next_path 콜백에서 같은 instance 를 공유해야 함.
    @account_home_feed ||= HomeFeed.new(current_account)
  end

  # Pagination cursor — HomeFeed#get 이 raw_statuses (redis-originated) 의 oldest/
  # newest ID 를 저장. inject_ancestors 가 chain compress 로 추가한 root 가
  # redis 페이지 범위 밖일 수 있으므로, 그 ID 를 cursor 로 쓰면 다음 페이지에서
  # 같은 root 가 또 등장하여 무한 loop 발생. raw statuses 기준 cursor 가 정확.
  def pagination_max_id
    account_home_feed.pagination_max_id
  end

  def pagination_since_id
    account_home_feed.pagination_since_id
  end

  def next_path
    api_v1_timelines_home_url next_path_params
  end

  def prev_path
    api_v1_timelines_home_url prev_path_params
  end
end
