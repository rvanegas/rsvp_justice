const request = require('superagent');
const _ = require('lodash');

const endpoint = 'https://api.meetup.com';
const key = '365716195410774d58f4f04c1c382a';

function firstEvent(events) {
  const mainEvents = events.filter(event => {
    const date = new Date(event.time);
    return date.getHours() == 13;
  });
  return mainEvents[0].id;
}

function nextEventId(next) {
  request.get(endpoint + '/philosophy-184/events')
  .query({status: 'upcoming'})
  .end((err, res) => next(firstEvent(res.body)));
}

function prevEventId(next) {
  request.get(endpoint + '/philosophy-184/events')
  .query({status: 'past', desc: true})
  .end((err, res) => next(firstEvent(res.body)));
}

function rsvps(event_id, next) {
  request.get(endpoint + '/2/rsvps')
  .query({event_id, key})
  .end((err, res) => {
    console.log(res.body.results.map(r => {
      return _.pick(r, ['member', 'response', 'guests', 'rsvp_id']);
    }));
  });
}

function attendance(event_id, next) {
  request.get(endpoint + '/philosophy-184/events/' + event_id + '/attendance')
  .query({key, filter: 'noshow'})
  .end((err, res) => {
    next(res.body);
  });
}

prevEventId(e => {
  console.log(e);
  attendance(e, b => console.log(b))
});

