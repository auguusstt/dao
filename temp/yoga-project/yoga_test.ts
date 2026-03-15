import Yoga from 'yoga-layout';

function test() {
    const root = Yoga.Node.create();
    root.setWidth(100);
    root.setHeight(100);

    const child = Yoga.Node.create();
    child.setWidth(50);
    child.setHeight(50);

    root.insertChild(child, 0);
    root.calculateLayout(100, 100, Yoga.DIRECTION_LTR);

    console.log('Root:', root.getComputedLayout());
    console.log('Child:', child.getComputedLayout());

    root.freeRecursive();
}

test();
