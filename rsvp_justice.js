const request = require('superagent');
const async = require('async');
const _ = require('lodash');
const fs = require('fs');

require('dotenv').config();
const urlname = process.env.MEETUP_URLNAME;
const key = process.env.MEETUP_KEY;
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
  request.get(endpoint + '/' + urlname + '/events')
  .query({status: 'upcoming', page: 10})
  .end((err, res) => next(null, firstEvent(res.body)));
}

function prevEventId(next) {
  request.get(endpoint + '/' + urlname + '/events')
  .query({status: 'past', desc: true, page: 10})
  .end((err, res) => next(null, firstEvent(res.body)));
}

function eventRsvps(event_id, next) {
  function trial(trialNext) {
    request.get(endpoint + '/2/rsvps')
    .query({event_id, key})
    .end((err, res) => {
      if (!res.body.results) {
        console.log('retrying...');
        trialNext(true);
      } else {
        const rsvps = res.body.results.map(r => _.pick(r, ['member', 'response', 'guests', 'rsvp_id']));
        trialNext(null, rsvps);
      }
    });
  }
  async.retry(trial, next);
}

function attendance(event_id, next) {
  request.get(endpoint + '/' + urlname + '/events/' + event_id + '/attendance')
  .query({key, filter: 'noshow'})
  .end((err, res) => next(null, res.body));
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
  prevEventId((err, event_id) => {
    attendance(event_id, (err, noshows) => {
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

function decrementPoints(member_id, next) {
  demerits.members[member_id].points -= 1;
  next();
}

function injustice(rsvps, next) {
  rsvps.map(rsvp => {
    const demeritMember = demerits.members[rsvp.member.member_id];
    const points = demeritMember ? demeritMember.points : 0;
    _.assign(rsvp, {points});
  });
  const highestYes = _.maxBy(_.filter(rsvps, {response: 'yes'}), 'points');
  const lowestWaitlist = _.minBy(_.filter(rsvps, {response: 'waitlist'}), 'points');
  highestYes.points > lowestWaitlist.points ?
    next(null, highestYes, lowestWaitlist) :
    next(true);
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
      decrementPoints(highestYes.member.member_id, next);
    });
  });
}

loadDemerits();
incrementPoints(() => {
  nextEventId((err, event_id) => {
    function adjust(next) {
      eventRsvps(event_id, (err, rsvps) => {
        injustice(rsvps, (err, highestYes, lowestWaitlist) => {
          err ? next(true) : swapPairMock(event_id, highestYes, lowestWaitlist, next);
        });
      });
    }
    async.forever(adjust, saveDemerits);
  });
});
