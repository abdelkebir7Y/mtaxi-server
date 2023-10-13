const pendingInvites = {};

const userOrders = {};

const addOrderToUser = (uuid, orderId) => {
  if (!userOrders[uuid]) {
    userOrders[uuid] = [];
  }
  userOrders[uuid].push(orderId);
};

const resendLastEvent = (orderNamespace, socket, orderId) => {
  const userRoom = socket.uuid;
  const { lastEvent, data = [] } = pendingInvites[orderId];

  orderNamespace.in(userRoom).emit(lastEvent, ...data);

  console.log("resend", lastEvent, data);

  // if (
  //   ["client-order-canceled", "complete-order", "pickup-client"].includes(
  //     lastEvent
  //   )
  // ) {
  //   userOrders[socket.uuid] = userOrders[socket.uuid].filter(
  //     (id) => id !== orderId
  //   );
  // }
};

const reJoinOrders = (orderNamespace, socket) => {
  console.log("rejoin", userOrders[socket.uuid]);
  if (userOrders[socket.uuid]) {
    userOrders[socket.uuid] = userOrders[socket.uuid].filter((orderId) => {
      if (!pendingInvites[orderId]) {
        return false;
      }
      console.log("rejoin", orderId);
      const orderRoom = "order" + orderId;
      socket.join(orderRoom);
      resendLastEvent(orderNamespace, socket, orderId);
      return true;
    });
  }
};

const autoCancelOrder = (orderNamespace, orderId) => {
  const orderRoom = "order" + orderId;
  const cancelCount = pendingInvites[orderId]?.cancelCount;
  setTimeout(() => {
    if (
      pendingInvites[orderId] &&
      ["new-order", "order-canceled"].includes(
        pendingInvites[orderId]?.lastEvent
      ) &&
      cancelCount === pendingInvites[orderId]?.cancelCount
    ) {
      orderNamespace.in(orderRoom).emit("server-cancel-order", orderId);
      console.log("server-cancel-order", orderId);
      delete pendingInvites[orderId];
    }
  }, 60000);
};

const newConnection = (orderNamespace, socket) => {
  const userRoomName = socket.uuid;
  console.log("new connection", userRoomName);
  socket.join(userRoomName);
  reJoinOrders(orderNamespace, socket);
};

const bookRide =
  (orderNamespace, socket) => (order, driversUuids, notification) => {
    const orderRoom = "order" + order.id;
    socket.join(orderRoom);
    addOrderToUser(socket.uuid, order.id);
    driversUuids.forEach((driverUuid) => {
      addOrderToUser(driverUuid, order.id);
      orderNamespace.in(driverUuid).emit("new-order", notification);
    });

    pendingInvites[order.id] = {
      lastEvent: "new-order",
      data: [notification],
    };

    autoCancelOrder(orderNamespace, order.id);

    console.log(userOrders);
  };

const receiveOrder = (socket) => (orderId) => {
  const orderRoom = "order" + orderId;
  socket.join(orderRoom);
};

const orderAccepted = (orderNamespace) => (orderId, driver) => {
  const orderRoom = "order" + orderId;
  orderNamespace.in(orderRoom).emit("order-accepted", orderId, driver);
  pendingInvites[orderId] = {
    lastEvent: "order-accepted",
    data: [orderId, driver],
    cancelCount: 0,
  };
};

const driverCancel = (orderNamespace, socket) => (orderId) => {
  const orderRoom = "order" + orderId;
  socket.leave(orderRoom);
  orderNamespace.in(orderRoom).emit("order-canceled", orderId);
  pendingInvites[orderId] = {
    lastEvent: "order-canceled",
    data: [orderId],
    cancelCount: pendingInvites[orderId]?.cancelCount
      ? pendingInvites[orderId]?.cancelCount + 1
      : 1,
  };
  autoCancelOrder(orderNamespace, orderId);
};

const clientCancel = (orderNamespace) => (orderId) => {
  const orderRoom = "order" + orderId;
  orderNamespace.in(orderRoom).emit("client-order-canceled", orderId);

  if (pendingInvites[orderId]?.lastEvent === "new-order") {
    delete pendingInvites[orderId];
    return;
  }

  pendingInvites[orderId] = {
    lastEvent: "client-order-canceled",
    data: [orderId],
  };
};

const complete = (orderNamespace) => (orderId, driver, fare) => {
  const orderRoom = "order" + orderId;
  orderNamespace.in(orderRoom).emit("complete-order", orderId, driver, fare);

  pendingInvites[orderId] = {
    lastEvent: "complete-order",
    data: [orderId, driver, fare],
  };
};

const pickup = (orderNamespace, socket) => (orderId, clientUuid) => {
  const orderRoom = "order" + orderId;

  orderNamespace
    .in(orderRoom)
    .fetchSockets()
    .then((sockets) => {
      sockets.forEach((_s) => {
        if (_s.uuid !== socket.uuid && _s.uuid !== clientUuid) {
          leaveOrder(_s)(orderId);
        }
      });
      orderNamespace.in(orderRoom).emit("pickup-client", orderId);
    });

  pendingInvites[orderId] = {
    lastEvent: "pickup-client",
    data: [orderId],
  };
};

const leaveOrder = (socket) => (orderId) => {
  const orderRoom = "order" + orderId;
  socket.leave(orderRoom);
  userOrders[socket.uuid] = userOrders[socket.uuid].filter(
    (id) => id !== orderId
  );
};

function listen(io) {
  const orderNamespace = io.of("/order");
  orderNamespace.use((socket, next) => {
    const uuid = socket.handshake.auth.uuid;

    if (!uuid) {
      return next(new Error("invalid uuid"));
    }

    socket.uuid = uuid;
    next();
  });

  orderNamespace.on("connection", (socket) => {
    newConnection(orderNamespace, socket);

    socket.on("book-ride", bookRide(orderNamespace, socket));

    socket.on("receive-order", receiveOrder(socket));

    socket.on("accept-order", orderAccepted(orderNamespace));

    socket.on("driver-cancel", driverCancel(orderNamespace, socket));

    socket.on("client-cancel", clientCancel(orderNamespace));

    socket.on("pickup", pickup(orderNamespace, socket));

    socket.on("complete", complete(orderNamespace));

    socket.on("leave-order", leaveOrder(socket));

    socket.on("client-confirm-remove-order", (orderId) => {
      console.log("client-confirm-remove-order", orderId);
      if (pendingInvites[orderId]) {
        if (
          pendingInvites[orderId]?.driverReceivedComplete ||
          pendingInvites[orderId]?.lastEvent !== "order-accepted"
        ) {
          delete pendingInvites[orderId];
          console.log("delete", orderId);
        }
        pendingInvites[orderId] = {
          ...pendingInvites[orderId],
          clientReceivedComplete: true,
        };
      }
    });

    socket.on("driver-confirm-remove-order", (orderId) => {
      console.log("driver-confirm-remove-order", orderId);
      if (pendingInvites[orderId]) {
        if (pendingInvites[orderId]?.clientReceivedComplete) {
          delete pendingInvites[orderId];
          console.log("delete", orderId);
        }
        pendingInvites[orderId] = {
          ...pendingInvites[orderId],
          driverReceivedComplete: true,
        };
      }
    });

    socket.on("online", () => {
      console.log("online", socket.uuid);
      socket.join(socket.uuid);
    });

    socket.on("disconnect", (reason) => {
      console.log(`Client ${socket.uuid} disconnected: ${reason}`);
    });
  });
}

module.exports = {
  listen,
};
