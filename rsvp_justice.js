const request = require('superagent');
const async = require('async');
const _ = require('lodash');
const fs = require('fs');

const key = '365716195410774d58f4f04c1c382a';
const endpoint = 'https://api.meetup.com';
const demeritsFile = 'demerits.json';

var demerits = {
  lastAdjudication: undefined,
  members: {},
};

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

function eventRsvps(event_id, next) {
  request.get(endpoint + '/2/rsvps')
  .query({event_id, key})
  .end((err, res) => {
    if (!res.body.results) {
      console.log('res.body.results = null');
      console.log('err', err);
      console.log('res', res);
      process.exit(1);
    }
    next(res.body.results.map(r => _.pick(r, ['member', 'response', 'guests', 'rsvp_id'])));
  });
}

function attendance(event_id, next) {
  request.get(endpoint + '/philosophy-184/events/' + event_id + '/attendance')
  .query({key, filter: 'noshow'})
  .end((err, res) => {
    next(res.body);
  });
}

function loadDemerits() {
  try {
    demerits = JSON.parse(fs.readFileSync(demeritsFile));
  } catch (e) {}
}

function saveDemerits() {
  fs.writeFileSync(demeritsFile, JSON.stringify(demerits));
}

function incrementPoints(next) {
  prevEventId(event_id => {
    attendance(event_id, noshows => {
      if (demerits.lastAdjudication != event_id) {
        demerits.lastAdjudication = event_id;
        noshows.forEach(noshow => {
          const {id, name} = noshow.member;
          const member = demerits.members[id];
          const points = (member && member.points + 1) || 1;
          demerits.members[id] = {name, points};
        });
        next();
      }
    });
  });
}

function injustice(rsvps, next) {
  rsvps.map(rsvp => {
    const demeritMember = demerits.members[rsvp.member.member_id];
    const points = demeritMember ? demeritMember.points : 0;
    _.assign(rsvp, {points});
  });
  const highestYes = _.maxBy(_.filter(rsvps, {response: 'yes'}), 'points');
  const lowestWaitlist = _.minBy(_.filter(rsvps, {response: 'waitlist'}), 'points');
  if (highestYes.points > lowestWaitlist.points) {
    next(null, highestYes, lowestWaitlist);
  } else {
    next(true);
  }
}

function setRsvpResponse(event_id, member_id, rsvp, next) {
  request.post(endpoint + '/2/rsvps')
  .query({event_id, member_id, rsvp})
  .end(next);
}

var count = 10;
function swapPairMock(event_id, highestYes, lowestWaitlist, next) {
  count -= 1;
  console.log(count, highestYes, lowestWaitlist);
  next(count > 0 ? null : true);
}

function swapPair(event_id, highestYes, lowestWaitlist, next) {
  setRsvpResponse(event_id, highestYes.member.member_id, 'waitlist', () => {
    setRsvpResponse(event_id, lowestWaitlist.member.member_id, 'yes', () => {
      demerits.members[highestYes.member.member_id].points -= 1;
      next();
    });
  });
}

loadDemerits();
incrementPoints(() => {
  nextEventId(event_id => {
    const adjust = next => {
      eventRsvps(event_id, rsvps => {
        injustice(rsvps, (err, highestYes, lowestWaitlist) => {
          err ? next(true) : swapPairMock(event_id, highestYes, lowestWaitlist, next);
        });
      });
    };
    async.forever(adjust, saveDemerits);
  });
});
