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
    HomeFeed.new(current_account)
  end

  # HomeFeed#inject_ancestors 가 chain 순서([root, parent, reply, ...]) 로 재배치
  # 하므로 @statuses 가 더 이상 ID 내림차순이 아님. 이 때문에 기본 pagination 의
  # `last.id` (= 가장 오래된 항목 가정) 가 깨져서 "더보기" 시 잉여/중복 페이지가
  # 발생함. 실제 min/max ID 를 명시적으로 계산해 정확한 커서를 보장.
  def pagination_max_id
    @statuses.map(&:id).min
  end

  def pagination_since_id
    @statuses.map(&:id).max
  end

  def next_path
    api_v1_timelines_home_url next_path_params
  end

  def prev_path
    api_v1_timelines_home_url prev_path_params
  end
end
