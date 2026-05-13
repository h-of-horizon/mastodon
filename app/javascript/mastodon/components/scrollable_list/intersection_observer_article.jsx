import PropTypes from 'prop-types';
import { cloneElement, Component } from 'react';

import scheduleIdleTask from '../../features/ui/util/schedule_idle_task';
import { Article } from './components';

// Diff these props in the "unrendered" state
const updateOnPropsForUnrendered = ['id', 'index', 'listLength'];

export class IntersectionObserverArticle extends Component {

  static propTypes = {
    intersectionObserverWrapper: PropTypes.object.isRequired,
    id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    index: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    listLength: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    children: PropTypes.node,
  };

  state = {
    isHidden: false, // set to true in requestIdleCallback to trigger un-render
  };

  shouldComponentUpdate (nextProps, nextState) {
    const isUnrendered = !this.state.isIntersecting && (this.state.isHidden);
    const willBeUnrendered = !nextState.isIntersecting && (nextState.isHidden);
    if (!!isUnrendered !== !!willBeUnrendered) {
      // If we're going from rendered to unrendered (or vice versa) then update
      return true;
    }
    // If we are and remain hidden, diff based on props
    if (isUnrendered) {
      return !updateOnPropsForUnrendered.every(prop => nextProps[prop] === this.props[prop]);
    }
    // Else, assume the children have changed
    return true;
  }

  componentDidMount () {
    const { intersectionObserverWrapper, id } = this.props;

    intersectionObserverWrapper.observe(
      id,
      this.node,
      this.handleIntersection,
    );

    this.componentMounted = true;
  }

  componentWillUnmount () {
    const { intersectionObserverWrapper, id } = this.props;
    intersectionObserverWrapper.unobserve(id, this.node);

    this.componentMounted = false;
  }

  handleIntersection = (entry) => {
    this.entry = entry;

    scheduleIdleTask(this.calculateHeight);
    this.setState(this.updateStateAfterIntersection);
  };

  updateStateAfterIntersection = (prevState) => {
    if (prevState.isIntersecting !== false && !this.entry.isIntersecting) {
      scheduleIdleTask(this.hideIfNotIntersecting);
    }
    return {
      isIntersecting: this.entry.isIntersecting,
      isHidden: false,
    };
  };

  calculateHeight = () => {
    this.height = this.entry.boundingClientRect.height;
  };

  hideIfNotIntersecting = () => {
    if (!this.componentMounted) {
      return;
    }

    // When the browser gets a chance, test if we're still not intersecting,
    // and if so, set our isHidden to true to trigger an unrender. The point of
    // this is to save DOM nodes and avoid using up too much memory.
    // See: https://github.com/mastodon/mastodon/issues/2900
    this.setState((prevState) => ({ isHidden: !prevState.isIntersecting }));
  };

  handleRef = (node) => {
    this.node = node;
  };

  render () {
    const { children, id, index, listLength } = this.props;
    const { isIntersecting, isHidden } = this.state;

    if (!isIntersecting && isHidden) {
      return (
        <Article
          ref={this.handleRef}
          aria-posinset={index + 1}
          aria-setsize={listLength}
          style={{ height: `${this.height}px`, opacity: 0, overflow: 'hidden' }}
          data-id={id}
        >
          {children && cloneElement(children, { hidden: true })}
        </Article>
      );
    }

    return (
      <Article ref={this.handleRef} aria-posinset={index + 1} aria-setsize={listLength} data-id={id}>
        {children && cloneElement(children, { hidden: false })}
      </Article>
    );
  }

}
